import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { serverProfiles, sessions } from '../db/schema.js';
import { getSessionChunkRanges, uncapDecompressionForTx } from '../db/timescale.js';
import {
  CAPTURED_START_SLACK_MS,
  historyServer,
  playsOf,
  watchHistoryPages,
} from '../services/import/tofaWatchHistory.js';
import { parseProfileNaming } from '../services/mediaServer/tofa/parser.js';
import { profileIdOf, profileSightings, resolveProfiles } from '../services/profiles.js';
import { getServerUserIdsByExternalId } from './poller/database.js';

/**
 * Links a server's plays stored without a profile to the profile that played them: by the
 * history row that records each play, then, for plays tofa no longer lists, by a stored profile
 * name that only one of the account's profiles has. Profiles the history names that tofa no
 * longer lists are added marked removed, so their plays link too. Paging stops at the oldest
 * unlinked play, so a profile named only on history pages older than that is not stored.
 * Returns the plays linked.
 */
export async function linkTofaPlayProfiles(
  serverId: string,
  onBatch: (linked: number) => Promise<void>
): Promise<number> {
  const { client } = await historyServer(serverId);
  const [oldestUnlinked] = await db
    .select({ startedAt: sessions.startedAt })
    .from(sessions)
    .where(and(eq(sessions.serverId, serverId), isNull(sessions.profileId)))
    .orderBy(asc(sessions.startedAt))
    .limit(1);
  if (!oldestUnlinked) return 0;

  let linked = 0;
  for await (const rows of watchHistoryPages(client)) {
    const newest = Math.max(...rows.map((row) => Date.parse(row.started_at)));
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
    linked += await db.transaction(async (tx) => {
      await uncapDecompressionForTx(tx);
      let written = 0;
      for (const [profileId, played] of Map.groupBy(plays, (play) => play.profileId)) {
        const { rowCount } = await tx
          .update(sessions)
          .set({ profileId })
          .where(
            and(
              playsOf(
                serverId,
                played.map((play) => play.row)
              ),
              inArray(sessions.serverUserId, [...new Set(played.map((play) => play.serverUserId))]),
              isNull(sessions.profileId)
            )
          );
        written += rowCount ?? 0;
      }
      return written;
    });
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
    linked += await db.transaction(async (tx) => {
      await uncapDecompressionForTx(tx);
      const { rowCount } = await tx
        .update(sessions)
        .set({ profileId: sql`${uniqueNames.id}` })
        .from(uniqueNames)
        .where(
          and(
            eq(sessions.serverId, serverId),
            isNull(sessions.profileId),
            isNotNull(sessions.profileName),
            eq(sessions.serverUserId, uniqueNames.serverUserId),
            eq(sessions.profileName, uniqueNames.name),
            ...(window
              ? [gte(sessions.startedAt, window.start), lt(sessions.startedAt, window.end)]
              : [])
          )
        );
      return rowCount ?? 0;
    });
    await onBatch(linked);
  }
  return linked;
}
