import { eq, sql, type SQL } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { uncapDecompressionForTx } from '../db/timescale.js';
import { getRedis } from '../lib/redisShared.js';
import { getServerTrackingStart } from '../services/import/trackingCutoff.js';
import {
  getImportedHistoryLinkState,
  getSettings,
  setImportedHistoryLinkState,
  type ImportedHistoryLinkState,
} from '../services/settings.js';
import { TautulliService } from '../services/tautulli.js';
import { normalizePlexGuid } from '../utils/plexGuid.js';
import { batchResolveMediaByPlexGuid, CONTAINER_MEDIA_TYPES_SQL } from './poller/database.js';
import {
  byInstant,
  drainWindowsWithBisection,
  sessionWalkWindows,
  ts,
  type BackfillWindow,
  type BackfillWalkResult,
} from './sessionWalk.js';

/**
 * One canonical identity for the orphan rows under a rating key and media type
 * whose external session id is a reference id Tautulli returned under that key.
 */
interface OrphanKeyLink {
  ratingKey: string;
  externalSessionIds: string[];
  mediaType: 'movie' | 'episode';
  mediaId: string;
  showMediaId: string | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
}

type LinkingTautulli = Pick<TautulliService, 'getPmsIdentifier' | 'getGuidsByRatingKey'>;

export interface ImportedHistoryLinkDeps {
  tautulli: LinkingTautulli | null;
  trigger: 'manual' | 'auto';
  hasPendingLibrarySync: (serverId: string) => Promise<boolean>;
}

interface ServerOutcome {
  serverId: string;
  ready: boolean;
  providerPassDone: boolean;
  complete: boolean;
}

type Window = Required<BackfillWindow> | null;

const BATCH_SIZE = 1000;
const GUID_KEYS_PER_REQUEST = 100;
const MIN_SCAN_VERSION = 2;
export const MAX_AUTO_LINK_ATTEMPTS = 5;
export const AUTO_LINK_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const AUTO_LINK_WARNING_MS = 48 * 60 * 60 * 1000;

/**
 * An import at or after the server's cutoff can be a play Tracearr also
 * tracked, so linking it would count that play twice.
 */
function sessionBounds(alias: string, serverId: string, cutoff: Date, window: Window): SQL {
  const a = sql.raw(alias);
  const server = sql`${a}.server_id = ${serverId}::uuid`;
  const beforeCutoff = sql`${a}.started_at < ${ts(cutoff)}`;
  if (!window) return sql`${server} AND ${beforeCutoff}`;
  return sql`${server} AND ${a}.started_at >= ${ts(window.start)} AND ${a}.started_at < ${ts(window.end)} AND ${beforeCutoff}`;
}

function startsAfterCutoff(window: Window, cutoff: Date): boolean {
  return window !== null && window.start >= cutoff;
}

/** Imported (or import-stamped) rows only: a tracked row's key can collide with an older server's. */
function orphan(alias: string): SQL {
  return sql.raw(
    `${alias}.media_id IS NULL AND ${alias}.rating_key IS NOT NULL AND ${alias}.external_session_id IS NOT NULL`
  );
}

interface PickedLink {
  id: string;
  started_at: string;
  rating_key: string;
  external_session_id: string;
  media_type: 'movie' | 'episode';
  media_id: string;
  show_media_id: string | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
}

/**
 * Select the rows to link read-only, then write only those rows. A compressed
 * chunk is decompressed for writing only when the window has something to
 * link, and the UPDATE target repeats the bounds and orphan predicates. A
 * provider id the match lacks never blanks the one the row already has.
 */
async function linkPicked(
  serverId: string,
  cutoff: Date,
  window: Window,
  pick: SQL,
  target: SQL
): Promise<{ count: number; oldest: Date | null }> {
  if (startsAfterCutoff(window, cutoff)) return { count: 0, oldest: null };
  const starts = await db.transaction(async (tx) => {
    const picked = (await tx.execute(pick)).rows as unknown as PickedLink[];
    if (picked.length === 0) return [];
    await uncapDecompressionForTx(tx);
    const updated = await tx.execute(sql`
      UPDATE sessions s
      SET media_id = p.media_id, show_media_id = p.show_media_id,
        imdb_id = COALESCE(p.imdb_id, s.imdb_id),
        tmdb_id = COALESCE(p.tmdb_id, s.tmdb_id),
        tvdb_id = COALESCE(p.tvdb_id, s.tvdb_id)
      FROM unnest(
        ${sql.param(picked.map((r) => r.id))}::uuid[],
        ${sql.param(picked.map((r) => r.started_at))}::timestamptz[],
        ${sql.param(picked.map((r) => r.rating_key))}::text[],
        ${sql.param(picked.map((r) => r.external_session_id))}::text[],
        ${sql.param(picked.map((r) => r.media_type))}::text[],
        ${sql.param(picked.map((r) => r.media_id))}::uuid[],
        ${sql.param(picked.map((r) => r.show_media_id))}::uuid[],
        ${sql.param(picked.map((r) => r.imdb_id))}::text[],
        ${sql.param(picked.map((r) => r.tmdb_id))}::int[],
        ${sql.param(picked.map((r) => r.tvdb_id))}::int[]
      ) AS p(id, started_at, rating_key, external_session_id, media_type, media_id,
        show_media_id, imdb_id, tmdb_id, tvdb_id)
      WHERE s.id = p.id AND s.started_at = p.started_at
        AND s.rating_key = p.rating_key AND s.external_session_id = p.external_session_id
        AND ${sessionBounds('s', serverId, cutoff, window)}
        AND s.media_type = p.media_type
        AND ${target}
        AND ${orphan('s')}
      RETURNING s.started_at
    `);
    return (updated.rows as Array<{ started_at: string }>).map((r) => r.started_at);
  });
  // Counting written rows, not picked ones: a picked row left unwritten would
  // be picked again, and the drain loop only stops on a short batch.
  const oldest = starts.sort(byInstant)[0];
  return { count: starts.length, oldest: oldest ? new Date(oldest) : null };
}

/**
 * Link orphan sessions whose rating key resolved to one canonical media row
 * through its Plex guid, matched on (rating key, external session id) pairs.
 * The link list only supplies values; the rows that change must also pass the
 * constant bounds and orphan predicates, so tracked rows under the same key never do.
 */
async function linkOrphanSessionsBatch(
  serverId: string,
  cutoff: Date,
  links: OrphanKeyLink[],
  limit: number,
  window: Window
): Promise<{ count: number; oldest: Date | null }> {
  const pairs = links.flatMap((link) =>
    link.externalSessionIds.map((externalSessionId) => ({ link, externalSessionId }))
  );
  if (pairs.length === 0) return { count: 0, oldest: null };
  const pairKeys = sql`${sql.param(pairs.map((p) => p.link.ratingKey))}::text[]`;
  const pairIds = sql`${sql.param(pairs.map((p) => p.externalSessionId))}::text[]`;

  return linkPicked(
    serverId,
    cutoff,
    window,
    sql`
      SELECT o.id, o.started_at, o.rating_key, o.external_session_id, l.media_type, l.media_id,
        CASE WHEN l.media_type = 'episode' THEN l.show_media_id END AS show_media_id,
        l.imdb_id, l.tmdb_id, l.tvdb_id
      FROM sessions o
      JOIN unnest(
        ${pairKeys},
        ${pairIds},
        ${sql.param(pairs.map((p) => p.link.mediaType))}::text[],
        ${sql.param(pairs.map((p) => p.link.mediaId))}::uuid[],
        ${sql.param(pairs.map((p) => p.link.showMediaId))}::uuid[],
        ${sql.param(pairs.map((p) => p.link.imdbId))}::text[],
        ${sql.param(pairs.map((p) => p.link.tmdbId))}::int[],
        ${sql.param(pairs.map((p) => p.link.tvdbId))}::int[]
      ) AS l(rating_key, external_session_id, media_type, media_id, show_media_id, imdb_id, tmdb_id, tvdb_id)
        ON l.rating_key = o.rating_key AND l.external_session_id = o.external_session_id
          AND l.media_type = o.media_type
      WHERE ${sessionBounds('o', serverId, cutoff, window)}
        AND o.rating_key = ANY(${sql.param(links.map((l) => l.ratingKey))}::text[])
        AND o.media_type IN ('movie', 'episode')
        AND ${orphan('o')}
      LIMIT ${limit}
    `,
    sql`s.media_type IN ('movie', 'episode')
      AND (s.rating_key, s.external_session_id) IN (SELECT * FROM unnest(${pairKeys}, ${pairIds}))`
  );
}

/**
 * Link orphan movie sessions that carry an IMDb or TMDB id to the one
 * canonical movie reachable through this server's library items by that id.
 * A row is skipped when either id matches more than one canonical movie, the
 * two ids match different ones, or the match carries an imdb, tmdb or tvdb id
 * that contradicts one the row already has.
 */
async function linkOrphanMoviesByProviderIdBatch(
  serverId: string,
  cutoff: Date,
  limit: number,
  window: Window
): Promise<{ count: number; oldest: Date | null }> {
  return linkPicked(
    serverId,
    cutoff,
    window,
    sql`
      WITH orphan AS (
        SELECT o.id, o.started_at, o.rating_key, o.external_session_id,
          o.imdb_id, o.tmdb_id, o.tvdb_id
        FROM sessions o
        WHERE ${sessionBounds('o', serverId, cutoff, window)}
          AND o.media_type = 'movie'
          AND ${orphan('o')}
          AND (o.imdb_id IS NOT NULL OR o.tmdb_id IS NOT NULL)
      ),
      canonical AS (
        SELECT DISTINCT c.id, c.imdb_id, c.tmdb_id, c.tvdb_id
        FROM library_items li
        JOIN media m ON m.id = li.media_id
        JOIN media c ON c.id = COALESCE(m.merged_into_id, m.id)
        WHERE li.server_id = ${serverId}::uuid
          AND li.media_type NOT IN (${CONTAINER_MEDIA_TYPES_SQL})
          AND c.media_type = 'movie'
          AND (c.imdb_id IN (SELECT imdb_id FROM orphan) OR c.tmdb_id IN (SELECT tmdb_id FROM orphan))
      ),
      by_imdb AS (
        SELECT imdb_id, min(id::text)::uuid AS media_id, count(*) AS matches
        FROM canonical WHERE imdb_id IS NOT NULL GROUP BY imdb_id
      ),
      by_tmdb AS (
        SELECT tmdb_id, min(id::text)::uuid AS media_id, count(*) AS matches
        FROM canonical WHERE tmdb_id IS NOT NULL GROUP BY tmdb_id
      )
      SELECT o.id, o.started_at, o.rating_key, o.external_session_id,
        'movie' AS media_type, c.id AS media_id,
        NULL::uuid AS show_media_id, c.imdb_id, c.tmdb_id, c.tvdb_id
      FROM orphan o
      LEFT JOIN by_imdb bi ON bi.imdb_id = o.imdb_id
      LEFT JOIN by_tmdb bt ON bt.tmdb_id = o.tmdb_id
      JOIN canonical c ON c.id = COALESCE(bi.media_id, bt.media_id)
      WHERE COALESCE(bi.matches, 1) = 1 AND COALESCE(bt.matches, 1) = 1
        AND (bi.media_id IS NULL OR bt.media_id IS NULL OR bi.media_id = bt.media_id)
        AND (o.imdb_id IS NULL OR c.imdb_id IS NULL OR c.imdb_id = o.imdb_id)
        AND (o.tmdb_id IS NULL OR c.tmdb_id IS NULL OR c.tmdb_id = o.tmdb_id)
        AND (o.tvdb_id IS NULL OR c.tvdb_id IS NULL OR c.tvdb_id = o.tvdb_id)
      LIMIT ${limit}
    `,
    sql`s.media_type = 'movie'`
  );
}

/** Distinct rating key and media type of the orphan rows, read one window at a time. */
async function collectOrphanKeys(
  serverId: string,
  cutoff: Date,
  windows: Required<BackfillWindow>[] | null
): Promise<
  Array<{ window: Window; keys: Array<{ ratingKey: string; mediaType: 'movie' | 'episode' }> }>
> {
  const collected = [];
  for (const window of windows ?? [null]) {
    if (startsAfterCutoff(window, cutoff)) continue;
    const result = await db.execute(sql`
      SELECT DISTINCT o.rating_key, o.media_type
      FROM sessions o
      WHERE ${sessionBounds('o', serverId, cutoff, window)}
        AND o.media_type IN ('movie', 'episode')
        AND ${orphan('o')}
    `);
    const rows = result.rows as Array<{ rating_key: string; media_type: 'movie' | 'episode' }>;
    collected.push({
      window,
      keys: rows.map((r) => ({ ratingKey: r.rating_key, mediaType: r.media_type })),
    });
  }
  return collected;
}

export async function listPlexServers(): Promise<
  Array<{ id: string; name: string; machineIdentifier: string | null }>
> {
  return db
    .select({ id: servers.id, name: servers.name, machineIdentifier: servers.machineIdentifier })
    .from(servers)
    .where(eq(servers.type, 'plex'));
}

/**
 * The server has finished at least one library sync, and every library with
 * items on it was last scanned by a query that stores plex_guid. Library rows
 * are written only once a sync has worked through all of the server's
 * libraries, so a server with none, including one with no libraries, waits.
 */
async function isLibraryScanReady(serverId: string): Promise<boolean> {
  const synced = await db.execute(
    sql`SELECT 1 FROM libraries WHERE server_id = ${serverId}::uuid LIMIT 1`
  );
  if (synced.rows.length === 0) return false;
  const result = await db.execute(
    sql`SELECT DISTINCT library_id FROM library_items WHERE server_id = ${serverId}::uuid`
  );
  const libraryIds = (result.rows as Array<{ library_id: string }>).map((r) => r.library_id);
  if (libraryIds.length === 0) return true;
  const versions = await getRedis().mget(
    libraryIds.map((libraryId) => REDIS_KEYS.LIBRARY_SYNC_SCAN_VERSION(serverId, libraryId))
  );
  return versions.every(
    (version) => version !== null && Number.parseInt(version, 10) >= MIN_SCAN_VERSION
  );
}

function nextImportedHistoryLinkState(
  prev: ImportedHistoryLinkState,
  run: { outcomes: ServerOutcome[]; failed: boolean },
  trigger: 'manual' | 'auto'
): ImportedHistoryLinkState {
  const providerPassDoneServers = [
    ...new Set([
      ...prev.providerPassDoneServers,
      ...run.outcomes.filter((o) => o.ready && o.providerPassDone).map((o) => o.serverId),
    ]),
  ];
  if (!run.failed && run.outcomes.every((o) => o.ready && o.complete)) {
    return { ...prev, state: 'done', providerPassDoneServers, autoAttempts: 0 };
  }
  const attempted = run.failed || run.outcomes.some((o) => o.ready && !o.complete);
  return {
    ...prev,
    state: 'pending',
    providerPassDoneServers,
    autoAttempts: prev.autoAttempts + (trigger === 'auto' && attempted ? 1 : 0),
  };
}

export async function importedHistoryLinkDeps(
  options: { trigger?: 'manual' | 'auto' } | undefined
): Promise<ImportedHistoryLinkDeps> {
  const config = await getSettings(['tautulliUrl', 'tautulliApiKey']);
  // librarySyncQueue.js imports this module through maintenanceQueue.js and librarySync.js.
  const { hasPendingLibrarySync } = await import('./librarySyncQueue.js');
  return {
    tautulli:
      config.tautulliUrl && config.tautulliApiKey
        ? new TautulliService(config.tautulliUrl, config.tautulliApiKey)
        : null,
    trigger: options?.trigger ?? 'manual',
    hasPendingLibrarySync,
  };
}

function counted(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Walk every Plex server: the provider-id pass, then the guid pass through
 * Tautulli, each draining the session chunk windows. The link state is
 * written when the walk ends, even when it throws, unless a re-arm moved its
 * generation meanwhile.
 */
export async function runImportedHistoryLinkingWalk(
  deps: ImportedHistoryLinkDeps & {
    onBatch: (total: number) => Promise<void>;
    onCommit: (oldest: Date | null) => void;
    batchSize?: number;
  }
): Promise<BackfillWalkResult & { details: string }> {
  const {
    tautulli,
    trigger,
    hasPendingLibrarySync,
    onBatch,
    onCommit,
    batchSize = BATCH_SIZE,
  } = deps;
  const before = await getImportedHistoryLinkState();
  const nearAutoLimit =
    trigger === 'auto' &&
    Date.parse(before.armedAt) + AUTO_LINK_WINDOW_MS - Date.now() < AUTO_LINK_WARNING_MS;
  const outcomes: ServerOutcome[] = [];
  const waiting: string[] = [];
  let failed = true;
  let capReached = false;
  let pending = true;
  let stateWritten = false;

  let total = 0;
  let earliest: Date | null = null;
  const failedRanges: string[] = [];
  const linked = { guid: 0, provider: 0 };
  const skipped = {
    ambiguous: 0,
    noGuid: 0,
    silent: 0,
    otherServer: 0,
    unfinished: 0,
  };

  const drain = async (
    serverId: string,
    windows: Required<BackfillWindow>[] | null,
    pass: keyof typeof linked,
    runBatch: (window: Window) => Promise<{ count: number; oldest: Date | null }>
  ) => {
    const result = await drainWindowsWithBisection(
      windows,
      async (window) => {
        const batch = await runBatch(window);
        total += batch.count;
        linked[pass] += batch.count;
        if (batch.oldest && (!earliest || batch.oldest < earliest)) earliest = batch.oldest;
        onCommit(batch.oldest);
        return batch;
      },
      {
        batchSize,
        label: `ImportedHistoryLinking:${pass}:${serverId}`,
        onBatch: async () => {
          await onBatch(total);
        },
      }
    );
    failedRanges.push(...result.failedRanges);
    return result.failedRanges.length === 0;
  };

  const guidPass = async (
    server: { id: string; machineIdentifier: string | null },
    cutoff: Date,
    client: LinkingTautulli,
    windows: Required<BackfillWindow>[] | null
  ): Promise<boolean> => {
    let pmsIdentifier: string | null;
    try {
      pmsIdentifier = await client.getPmsIdentifier();
    } catch (err) {
      console.warn(`[ImportedHistoryLinking] Tautulli server info failed: ${errorMessage(err)}`);
      return false;
    }
    if (!pmsIdentifier || !server.machineIdentifier) return false;
    if (pmsIdentifier !== server.machineIdentifier) {
      skipped.otherServer++;
      return true;
    }

    const collected = await collectOrphanKeys(server.id, cutoff, windows);
    const typesByKey = new Map<string, Set<'movie' | 'episode'>>();
    for (const { keys } of collected) {
      for (const { ratingKey, mediaType } of keys) {
        typesByKey.set(
          ratingKey,
          (typesByKey.get(ratingKey) ?? new Set<'movie' | 'episode'>()).add(mediaType)
        );
      }
    }
    const candidates: Array<{ ratingKey: string; mediaType: 'movie' | 'episode' }> = [];
    for (const [ratingKey, types] of typesByKey) {
      const [mediaType] = types;
      if (types.size === 1 && mediaType) candidates.push({ ratingKey, mediaType });
      else skipped.ambiguous++;
    }

    let complete = true;
    const links: OrphanKeyLink[] = [];
    for (let i = 0; i < candidates.length; i += GUID_KEYS_PER_REQUEST) {
      const batch = candidates.slice(i, i + GUID_KEYS_PER_REQUEST);
      let history: Awaited<ReturnType<LinkingTautulli['getGuidsByRatingKey']>>;
      try {
        history = await client.getGuidsByRatingKey(batch.map((c) => c.ratingKey));
      } catch (err) {
        console.warn(`[ImportedHistoryLinking] Tautulli history failed: ${errorMessage(err)}`);
        complete = false;
        break;
      }
      if (!history) {
        complete = false;
        continue;
      }

      const lookups: Array<{
        ratingKey: string;
        mediaType: 'movie' | 'episode';
        guid: string;
        externalSessionIds: string[];
      }> = [];
      let returnedKeys = 0;
      for (const { ratingKey, mediaType } of batch) {
        const rows = history.get(ratingKey);
        if (!rows || rows.guids.size === 0) continue;
        returnedKeys++;
        const stripped = new Set([...rows.guids].map((guid) => guid.split('?')[0] ?? ''));
        const [only] = stripped;
        if (stripped.size !== 1) {
          skipped.ambiguous++;
          continue;
        }
        const normalized = normalizePlexGuid(only);
        if (!normalized || normalized.mediaType !== mediaType) {
          skipped.noGuid++;
          continue;
        }
        lookups.push({
          ratingKey,
          mediaType,
          guid: normalized.guid,
          externalSessionIds: [...rows.referenceIds],
        });
      }
      // Tautulli answers a failed history query with an empty success, so a
      // batch with no rows for any of its keys cannot count as answered.
      if (returnedKeys === 0) {
        skipped.silent += batch.length;
        complete = false;
        continue;
      }

      const resolved = await batchResolveMediaByPlexGuid(
        server.id,
        lookups.map(({ guid, mediaType }) => ({ guid, mediaType }))
      );
      for (const { ratingKey, mediaType, guid, externalSessionIds } of lookups) {
        const identity = resolved.get(guid);
        if (!identity) continue;
        links.push({
          ratingKey,
          externalSessionIds,
          mediaType,
          mediaId: identity.mediaId,
          showMediaId: mediaType === 'episode' ? identity.showMediaId : null,
          imdbId: identity.imdbId,
          tmdbId: identity.tmdbId,
          tvdbId: identity.tvdbId,
        });
      }
    }
    if (links.length > 0) {
      const linksFor = (window: Window) => {
        if (!window) return links;
        const keys = new Set<string>();
        for (const c of collected) {
          if (c.window && (c.window.end <= window.start || window.end <= c.window.start)) continue;
          for (const k of c.keys) keys.add(k.ratingKey);
        }
        return links.filter((l) => keys.has(l.ratingKey));
      };
      const drained = await drain(server.id, windows, 'guid', (window) =>
        linkOrphanSessionsBatch(server.id, cutoff, linksFor(window), batchSize, window)
      );
      if (!drained) complete = false;
    }
    return complete;
  };

  try {
    const plexServers = await listPlexServers();
    const runs = plexServers.map((server) => {
      const outcome: ServerOutcome = {
        serverId: server.id,
        ready: false,
        providerPassDone: false,
        complete: false,
      };
      outcomes.push(outcome);
      return { server, outcome };
    });

    for (const { server, outcome } of runs) {
      if ((await hasPendingLibrarySync(server.id)) || !(await isLibraryScanReady(server.id))) {
        waiting.push(server.name);
        continue;
      }
      outcome.ready = true;
      const cutoff = await getServerTrackingStart(server.id);
      if (!cutoff) continue;
      const windows = await sessionWalkWindows(null);

      outcome.providerPassDone =
        before.providerPassDoneServers.includes(server.id) ||
        (await drain(server.id, windows, 'provider', (window) =>
          linkOrphanMoviesByProviderIdBatch(server.id, cutoff, batchSize, window)
        ));

      const guidComplete = tautulli ? await guidPass(server, cutoff, tautulli, windows) : true;
      if (tautulli && !guidComplete) skipped.unfinished++;
      outcome.complete = outcome.providerPassDone && guidComplete;
    }
    failed = false;
  } finally {
    const next = nextImportedHistoryLinkState(before, { outcomes, failed }, trigger);
    const written = await setImportedHistoryLinkState(before.generation, next);
    pending = next.state === 'pending';
    stateWritten = written;
    capReached =
      written &&
      before.autoAttempts < MAX_AUTO_LINK_ATTEMPTS &&
      next.autoAttempts >= MAX_AUTO_LINK_ATTEMPTS;
  }

  const parts: string[] = [];
  if (linked.guid > 0) {
    parts.push(`linked ${counted(linked.guid, 'imported play')} using Tautulli history`);
  }
  if (linked.provider > 0) {
    parts.push(`linked ${counted(linked.provider, 'imported movie play')} by IMDb or TMDB id`);
  }
  if (parts.length === 0) parts.push('no imported plays were linked');
  if (waiting.length > 0) {
    parts.push(
      `waiting for a library sync or a full library scan on ${waiting.length === 1 ? 'Plex server' : 'Plex servers'} ${waiting.join(', ')}`
    );
  }
  if (skipped.ambiguous > 0) {
    parts.push(`skipped ${counted(skipped.ambiguous, 'title')} matching more than one Plex item`);
  }
  if (skipped.noGuid > 0) {
    parts.push(`skipped ${counted(skipped.noGuid, 'title')} with no matching Plex id in Tautulli`);
  }
  if (skipped.silent > 0) {
    parts.push(`Tautulli returned no history for ${counted(skipped.silent, 'title')}`);
  }
  if (skipped.otherServer > 0) {
    parts.push(
      `did not use Tautulli history on ${counted(skipped.otherServer, 'Plex server')} Tautulli does not monitor`
    );
  }
  if (skipped.unfinished > 0) {
    parts.push(
      `could not finish linking through Tautulli history on ${counted(skipped.unfinished, 'Plex server')}`
    );
  }
  let details = parts.join('; ');
  details = details.charAt(0).toUpperCase() + details.slice(1);
  if (capReached) {
    details += `. Automatic runs stopped after ${MAX_AUTO_LINK_ATTEMPTS} incomplete attempts; run Link Imported Plex History from Settings > Jobs to retry`;
  } else if (nearAutoLimit && pending && stateWritten) {
    details +=
      '. Automatic runs stop 14 days after the last Tautulli import, Tautulli settings save or added Plex server; run Link Imported Plex History from Settings > Jobs to retry';
  }
  return { total, earliest, failedRanges, details };
}
