import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import { db } from '../db/client.js';
import { serverProfiles, sessions } from '../db/schema.js';
import {
  getCompressedSessionChunkRanges,
  getSessionChunkRanges,
  rangeReachesChunk,
  sessionRowPoint,
  uncapDecompressionForTx,
  type SessionRowPoint,
} from '../db/timescale.js';
import { CAPTURED_START_SLACK_MS } from '../services/import/serverHistory.js';
import { historyServer, playsOf, watchHistoryPages } from '../services/import/tofaWatchHistory.js';
import { parseProfileNaming } from '../services/mediaServer/tofa/parser.js';
import { profileIdOf, profileSightings, resolveProfiles } from '../services/profiles.js';
import { getServerUserIdsByExternalId } from './poller/database.js';

/**
 * Above this many plays a pass over a compressed chunk links them with its one statement instead
 * of point updates. Each point update of the name pass carries the unique-name join: over a
 * 40,000-row chunk with the plays spread across it, they cost as much as the window statement at
 * about 45 plays on TimescaleDB 2.28 and about 50 on 2.31.
 */
export const MAX_POINT_UPDATES_PER_PROFILE_PASS = 40;

/** started_at as Postgres text, microseconds intact */
const UNLINKED = {
  id: sessions.id,
  started_at: sql<string>`${sessions.startedAt}::text`,
  server_user_id: sessions.serverUserId,
  server_id: sessions.serverId,
};

/**
 * Links a server's plays stored without a profile to the profile that played them: by the
 * history row that records each play, then, for plays tofa no longer lists, by a stored profile
 * name that only one of the account's profiles has. Profiles the history names that tofa no
 * longer lists are added marked removed, so their plays link too. Paging stops at the oldest
 * unlinked play, so a profile named only on history pages older than that is not stored.
 * Returns the plays linked.
 *
 * A statement bounded by a time span decompresses every compressed batch of the server it
 * reaches, even with nothing to link. Where a span reaches a compressed chunk the plays are read
 * first and nothing is written when none links; up to MAX_POINT_UPDATES_PER_PROFILE_PASS plays
 * then each take a point update on the play's constant key and segment under the same predicate,
 * which decompresses only the batch holding the play.
 */
export async function linkTofaPlayProfiles(
  serverId: string,
  onBatch: (linked: number) => Promise<void>
): Promise<number> {
  const { client } = await historyServer(serverId);
  // The maintenance walk runs this with compression paused, so no chunk becomes compressed during
  // it. Read alongside the oldest unlinked play, so the chunk list costs no round trip of its own.
  const [[oldestUnlinked], compressed] = await Promise.all([
    db
      .select({ startedAt: sessions.startedAt })
      .from(sessions)
      .where(and(eq(sessions.serverId, serverId), isNull(sessions.profileId)))
      .orderBy(asc(sessions.startedAt))
      .limit(1),
    getCompressedSessionChunkRanges(),
  ]);
  if (!oldestUnlinked) return 0;

  const pointOf = (play: SessionRowPoint, where: SQL | undefined) =>
    and(sessionRowPoint('sessions', play), where);

  let linked = 0;
  for await (const rows of watchHistoryPages(client)) {
    const starts = rows.map((row) => Date.parse(row.started_at));
    const newest = Math.max(...starts);
    if (newest + CAPTURED_START_SLACK_MS < oldestUnlinked.startedAt.getTime()) break;
    // Through merge aliases too: a folded account's plays sit on the account it was folded into
    const accountOf = await getServerUserIdsByExternalId(
      serverId,
      rows.map((row) => row.user_id)
    );
    const profiles = await resolveProfiles(
      serverId,
      profileSightings(rows.map(parseProfileNaming), (accountId) => accountOf.get(accountId)),
      'insertRemoved'
    );
    const plays = rows.flatMap((row) => {
      const profileId = profileIdOf(profiles, row.profile_id);
      const serverUserId = accountOf.get(row.user_id);
      return profileId && serverUserId ? [{ row, profileId, serverUserId }] : [];
    });
    // In profile order, so a play two profiles' history rows both match goes to the first
    const groups = [...Map.groupBy(plays, (play) => play.profileId)].map(([profileId, played]) => ({
      profileId,
      where: and(
        playsOf(
          serverId,
          played.map((play) => play.row)
        ),
        inArray(sessions.serverUserId, [...new Set(played.map((play) => play.serverUserId))]),
        isNull(sessions.profileId)
      ),
    }));
    const spanStart = Math.min(...starts) - CAPTURED_START_SLACK_MS;
    const spanEnd = newest + CAPTURED_START_SLACK_MS;
    const reachesCompressed = rangeReachesChunk(compressed, {
      start: new Date(spanStart),
      end: new Date(spanEnd),
      endInclusive: true,
    });
    // Each play read goes with the first group whose predicate it meets, the group that writes it
    const read =
      reachesCompressed && groups.length > 0
        ? await db
            .select({
              ...UNLINKED,
              group: sql<number>`CASE ${sql.join(
                groups.map((group, i) => sql`WHEN ${group.where} THEN ${sql.raw(String(i))}`),
                sql` `
              )} END`.mapWith(Number),
            })
            .from(sessions)
            .where(or(...groups.map((group) => group.where)))
            .limit(MAX_POINT_UPDATES_PER_PROFILE_PASS + 1)
        : null;
    if (groups.length > 0 && (!read || read.length > 0)) {
      linked += await db.transaction(async (tx) => {
        await uncapDecompressionForTx(tx);
        const writes =
          read && read.length <= MAX_POINT_UPDATES_PER_PROFILE_PASS
            ? read.flatMap((play) => {
                const group = groups[play.group];
                return group
                  ? [{ profileId: group.profileId, where: pointOf(play, group.where) }]
                  : [];
              })
            : groups;
        let written = 0;
        for (const { profileId, where } of writes) {
          const { rowCount } = await tx.update(sessions).set({ profileId }).where(where);
          written += rowCount ?? 0;
        }
        return written;
      });
    }
    await onBatch(linked);
  }

  const uniqueNames = db
    .select({
      id: sql<string>`(array_agg(${serverProfiles.id}))[1]`.as('named_profile_id'),
      serverUserId: serverProfiles.serverUserId,
      name: serverProfiles.name,
    })
    .from(serverProfiles)
    .where(eq(serverProfiles.serverId, serverId))
    .groupBy(serverProfiles.serverUserId, serverProfiles.name)
    .having(sql`count(*) = 1`)
    .as('unique_names');
  // A chunk at a time, so no statement decompresses more than one chunk of the server's plays
  const chunks = await getSessionChunkRanges();
  const windows =
    chunks.length > 0 ? chunks.filter((chunk) => chunk.end > oldestUnlinked.startedAt) : [null];
  for (const window of windows) {
    const where = and(
      eq(sessions.serverId, serverId),
      isNull(sessions.profileId),
      isNotNull(sessions.profileName),
      eq(sessions.serverUserId, uniqueNames.serverUserId),
      eq(sessions.profileName, uniqueNames.name),
      ...(window ? [gte(sessions.startedAt, window.start), lt(sessions.startedAt, window.end)] : [])
    );
    const read =
      window && rangeReachesChunk(compressed, window)
        ? await db
            .select(UNLINKED)
            .from(sessions)
            .innerJoin(uniqueNames, sql`true`)
            .where(where)
            .limit(MAX_POINT_UPDATES_PER_PROFILE_PASS + 1)
        : null;
    if (!read || read.length > 0) {
      linked += await db.transaction(async (tx) => {
        await uncapDecompressionForTx(tx);
        let written = 0;
        const targets =
          read && read.length <= MAX_POINT_UPDATES_PER_PROFILE_PASS
            ? read.map((play) => pointOf(play, where))
            : [where];
        for (const target of targets) {
          const { rowCount } = await tx
            .update(sessions)
            .set({ profileId: sql`${uniqueNames.id}` })
            .from(uniqueNames)
            .where(target);
          written += rowCount ?? 0;
        }
        return written;
      });
    }
    await onBatch(linked);
  }
  return linked;
}
