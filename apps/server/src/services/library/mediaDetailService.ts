/**
 * Media detail query layer, shared by the public API v2 /media routes and
 * the internal /library/media routes.
 *
 * Every query threads `serverIds: string[] | undefined` through
 * buildMultiServerFragment: undefined (v2's call shape) produces the exact
 * same unscoped SQL v2 always ran, so this extraction changes nothing about
 * v2 behavior. The internal routes pass a caller's resolved scope instead.
 */

import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { WatchedState } from '@tracearr/shared';
import { countedSessionSql } from '../../db/sessions/rules.js';
import { db } from '../../db/client.js';
import { media, servers } from '../../db/schema.js';
import { buildMultiServerFragment, serverIdCondition } from '../../utils/serverFiltering.js';
import {
  libraryFragment,
  scopeFragment,
  scopeSessionsRaw,
  scopedServerFragment,
  type Scope,
} from '../../lib/scope.js';
import { uuidArraySql } from '../../utils/sqlArrays.js';
import { buildPosterOrderFragment } from '../../routes/library/catalog.js';
import { parseMediaRef } from './mediaRef.js';
import { resolveMediaAliases } from './mediaResolutionService.js';
import { resolveWatchedStates } from './mediaWatchedService.js';
import {
  idList,
  runHistoryPage,
  STATS_WINDOWS,
  windowDayFilter,
  type StatsWindowKey,
} from '../../routes/publicV2/shared.js';

export type MediaDetailRow = typeof media.$inferSelect;

// Season number is only recoverable from the season match key season:<showUuid>:s<n>
const SEASON_KEY_RE = /^season:[0-9a-f-]+:s(\d+)$/i;
export function seasonNumberFromKey(matchKey: string): number | null {
  const m = SEASON_KEY_RE.exec(matchKey);
  return m ? Number(m[1]) : null;
}

/** Resolve a media uuid or type-qualified provider ref to its canonical media row. */
export async function resolveCanonicalMediaByRef(ref: string): Promise<MediaDetailRow | null> {
  const parsed = parseMediaRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'uuid') {
    const [row] = await db.select().from(media).where(eq(media.id, parsed.id));
    if (!row) return null;
    if (!row.mergedIntoId) return row;
    const [winner] = await db.select().from(media).where(eq(media.id, row.mergedIntoId));
    return winner ?? row;
  }
  const col =
    parsed.provider === 'imdb'
      ? media.imdbId
      : parsed.provider === 'tmdb'
        ? media.tmdbId
        : media.tvdbId;
  let value: string | number = parsed.id;
  if (parsed.provider !== 'imdb') {
    const n = Number(parsed.id);
    if (!Number.isInteger(n)) return null;
    value = n;
  }
  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.mediaType, parsed.mediaType), eq(col, value), isNull(media.mergedIntoId)));
  return row ?? null;
}

export interface MediaScope {
  kind: 'media' | 'show' | 'season' | 'artist';
  aliases: string[];
  seasonNumber: number | null;
  showAliases: string[];
}

/** Resolves the alias/hierarchy scope a canonical media row's sessions live under. */
export async function buildMediaScope(canonical: MediaDetailRow): Promise<MediaScope | null> {
  if (canonical.mediaType === 'season') {
    const n = seasonNumberFromKey(canonical.matchKey);
    if (n === null || !canonical.showMediaId) return null;
    const showAliases = await resolveMediaAliases(canonical.showMediaId);
    return {
      kind: 'season',
      aliases: [],
      seasonNumber: n,
      showAliases: showAliases.length > 0 ? showAliases : [canonical.showMediaId],
    };
  }
  const aliases = await resolveMediaAliases(canonical.id);
  const ids = aliases.length > 0 ? aliases : [canonical.id];
  return {
    kind:
      canonical.mediaType === 'show' || canonical.mediaType === 'artist'
        ? canonical.mediaType
        : 'media',
    aliases: ids,
    seasonNumber: null,
    showAliases: [],
  };
}

/** The plays aggregates carry no season number and no track's artist key, so these read sessions. */
function readsSessions(scope: MediaScope): boolean {
  return scope.kind === 'season' || scope.kind === 'artist';
}

export function scopeSessionConditions(scope: MediaScope): SQL[] {
  if (scope.kind === 'artist') {
    return [
      sql`s.media_type = 'track'`,
      sql`(s.server_id, s.grandparent_rating_key) IN (
        SELECT ar.server_id, ar.rating_key FROM library_items ar
        WHERE ar.media_id IN (${idList(scope.aliases)})
          AND ar.media_type = 'artist' AND ar.removed_at IS NULL
      )`,
    ];
  }
  if (scope.kind === 'season') {
    return [
      sql`s.show_media_id IN (${idList(scope.showAliases)})`,
      sql`s.season_number = ${scope.seasonNumber}`,
    ];
  }
  if (scope.kind === 'show') {
    return [sql`s.show_media_id IN (${idList(scope.aliases)})`];
  }
  return [sql`s.media_id IN (${idList(scope.aliases)})`];
}

export interface AvailabilityRow {
  server_id: string;
  server_type: string;
  library_id: string;
  /** Null when the owning server hasn't synced its library names yet (see librarySync.ts). */
  library_name: string | null;
  rating_key: string;
  added_at: Date;
  removed_at: Date | null;
  video_resolution: string | null;
  file_size: string | number | null;
  /** Show rows only: summed episode file bytes in the same server+library. */
  episode_file_size: string | number | null;
  /** Show rows only: distinct episode resolutions, most frequent first. */
  episode_resolutions: string[] | null;
  /** Show rows only: active episode count in the same server+library. */
  episode_count: number | null;
  /** Physical files of this copy, largest first; empty for containers. */
  versions: Array<{
    resolution: string | null;
    videoCodec: string | null;
    audioCodec: string | null;
    dynamicRange: string | null;
    audioAtmos: boolean;
    editionTitle: string | null;
    container: string | null;
    fileSize: number | null;
  }>;
  /** Copy this row replaced (event-witnessed); fields null when none. */
  replaces_added_at: Date | null;
  replaces_removed_at: Date | null;
  replaces_video_resolution: string | null;
  replaces_file_size: string | number | null;
}

export interface PosterCopy {
  thumbPath: string;
  dominantColor: string | null;
  serverId: string;
}

/**
 * Whether a member's library limit hides a title. Hidden when it has copies on their servers
 * and none of them in a library they can open, and also when it has no copies anywhere
 * (imported history of a title the library never held) unless one of the member's own
 * accounts played it. Staff, and members without a library limit, see every title.
 */
export async function hiddenByLibraryLimit(
  mediaId: string,
  serverIds: string[] | undefined,
  scope: Scope
): Promise<boolean> {
  if (scope === 'all' || Object.keys(scope.libraryIds ?? {}).length === 0) return false;
  const result = await db.execute(sql`
    SELECT (EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.media_id = ${mediaId} ${buildMultiServerFragment(serverIds, 'li.server_id')}
      ) AND NOT EXISTS (
        SELECT 1 FROM library_items li
        WHERE li.media_id = ${mediaId} ${libraryFragment(serverIds, scope, 'li')}
      )) OR (NOT EXISTS (
        SELECT 1 FROM library_items li WHERE li.media_id = ${mediaId}
      ) AND NOT EXISTS (
        SELECT 1 FROM user_media_plays_daily p
        WHERE (p.media_id IN (SELECT id FROM media WHERE id = ${mediaId} OR merged_into_id = ${mediaId})
            OR p.show_media_id IN (SELECT id FROM media WHERE id = ${mediaId} OR merged_into_id = ${mediaId}))
          ${scopeFragment(scope, sql`p.server_user_id`)}
      )) AS hidden
  `);
  return (result.rows[0] as { hidden: boolean } | undefined)?.hidden === true;
}

/** Ordered the same way the catalog picks its poster, so the two never disagree. */
export async function getPosterCopy(
  mediaId: string,
  serverIds: string[] | undefined,
  preferredServerId: string | null | undefined,
  scope: Scope = 'all'
): Promise<PosterCopy | null> {
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const result = await db.execute(sql`
    SELECT li.thumb_path, li.dominant_color, li.server_id
    FROM library_items li
    WHERE li.media_id = ${mediaId}
      AND li.removed_at IS NULL
      AND li.thumb_path IS NOT NULL
      ${serverFragmentLi}
    ${buildPosterOrderFragment(preferredServerId)}
    LIMIT 1
  `);
  const row = result.rows[0] as
    { thumb_path: string; dominant_color: string | null; server_id: string } | undefined;
  if (!row) return null;
  return {
    thumbPath: row.thumb_path,
    dominantColor: row.dominant_color,
    serverId: row.server_id,
  };
}

export interface MediaAvailabilityResult {
  availability: AvailabilityRow[];
  seasonCount: number | null;
  episodeCount: number | null;
}

/** Per-server availability rows plus (for shows) active season/episode counts. */
export async function getAvailability(
  mediaId: string,
  mediaType: string,
  serverIds: string[] | undefined,
  scope: Scope = 'all'
): Promise<MediaAvailabilityResult> {
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const availRes = await db.execute(sql`
    SELECT
      li.server_id,
      sv.type AS server_type,
      li.library_id,
      lib.name AS library_name,
      li.rating_key,
      li.created_at AS added_at,
      li.removed_at,
      li.video_resolution,
      li.file_size,
      NULL AS episode_file_size,
      NULL AS episode_resolutions,
      NULL AS episode_count,
      COALESCE((
        SELECT json_agg(json_build_object(
          'resolution', v.video_resolution,
          'videoCodec', v.video_codec,
          'audioCodec', v.audio_codec,
          'dynamicRange', v.video_dynamic_range,
          'audioAtmos', v.audio_atmos,
          'editionTitle', v.edition_title,
          'container', v.container,
          'fileSize', v.file_size
        ) ORDER BY v.file_size DESC NULLS LAST)
        FROM library_item_versions v
        WHERE v.library_item_id = li.id AND v.removed_at IS NULL
      ), '[]'::json) AS versions,
      rep.created_at AS replaces_added_at,
      rep.removed_at AS replaces_removed_at,
      rep.video_resolution AS replaces_video_resolution,
      rep.file_size AS replaces_file_size
    FROM library_items li
    JOIN servers sv ON sv.id = li.server_id
    LEFT JOIN libraries lib ON lib.server_id = li.server_id AND lib.library_id = li.library_id
    -- the join requires the target still tombstoned, so a revived predecessor
    -- invalidates the link at read time and both copies render separately
    LEFT JOIN library_items rep
      ON rep.id = li.replaces_library_item_id AND rep.removed_at IS NOT NULL
    WHERE li.media_id = ${mediaId} ${serverFragmentLi}
      AND NOT (li.removed_at IS NOT NULL AND EXISTS (
        SELECT 1 FROM library_items succ
        WHERE succ.replaces_library_item_id = li.id AND succ.removed_at IS NULL
      ))
    ORDER BY (li.removed_at IS NULL), li.created_at ASC, li.rating_key ASC
  `);
  const availability = availRes.rows as unknown as AvailabilityRow[];

  // A show's own library_items row carries no size or resolution - roll both
  // up from its episodes' files, per server+library, in one query for all rows.
  if (mediaType === 'show' && availability.length > 0) {
    const serverFragmentEp = libraryFragment(serverIds, scope, 'li');
    const rollupRes = await db.execute(sql`
      WITH ep AS (
        SELECT li.server_id, li.library_id, li.media_id, li.file_size, li.video_resolution
        FROM library_items li
        JOIN media m ON m.id = li.media_id
        WHERE m.show_media_id = ${mediaId}
          AND m.media_type = 'episode'
          AND li.removed_at IS NULL
          ${serverFragmentEp}
      ),
      res AS (
        SELECT server_id, library_id, video_resolution, COUNT(*) AS freq
        FROM ep
        WHERE video_resolution IS NOT NULL
        GROUP BY server_id, library_id, video_resolution
      )
      SELECT
        e.server_id,
        e.library_id,
        SUM(e.file_size) AS episode_file_size,
        COUNT(DISTINCT e.media_id)::int AS episode_count,
        (SELECT ARRAY_AGG(r.video_resolution ORDER BY r.freq DESC, r.video_resolution)
           FROM res r
          WHERE r.server_id = e.server_id AND r.library_id = e.library_id) AS episode_resolutions
      FROM ep e
      GROUP BY e.server_id, e.library_id
    `);
    const rollupByKey = new Map(
      (
        rollupRes.rows as unknown as {
          server_id: string;
          library_id: string;
          episode_file_size: string | number | null;
          episode_count: number;
          episode_resolutions: string[] | null;
        }[]
      ).map((r) => [`${r.server_id}:${r.library_id}`, r])
    );
    for (const row of availability) {
      const rollup = rollupByKey.get(`${row.server_id}:${row.library_id}`);
      if (rollup) {
        row.episode_file_size = rollup.episode_file_size;
        row.episode_resolutions = rollup.episode_resolutions;
        row.episode_count = rollup.episode_count;
      }
    }
  }

  let seasonCount: number | null = null;
  let episodeCount: number | null = null;
  if (mediaType === 'show') {
    const serverFragmentLi2 = libraryFragment(serverIds, scope, 'li');
    const counts = await db.execute(sql`
      SELECT
        COUNT(*) FILTER (WHERE m.media_type = 'season') AS season_count,
        COUNT(*) FILTER (WHERE m.media_type = 'episode') AS episode_count
      FROM media m
      WHERE m.show_media_id = ${mediaId}
        AND m.media_type IN ('season', 'episode')
        AND EXISTS (
          SELECT 1 FROM library_items li
          WHERE li.media_id = m.id AND li.removed_at IS NULL ${serverFragmentLi2}
        )
    `);
    const row = counts.rows[0] as { season_count: string; episode_count: string };
    seasonCount = Number(row.season_count);
    episodeCount = Number(row.episode_count);
  }

  return { availability, seasonCount, episodeCount };
}

interface EpisodeChildRow {
  id: string;
  title: string;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  show_media_id: string | null;
  genres: string[] | null;
  episode_number: number | null;
}

export interface MediaChildRow {
  id: string;
  media_type: 'season' | 'episode' | 'album';
  title: string;
  season_number: number | null;
  episode_count: number | null;
  episode_number: number | null;
  imdb_id: string | null;
  tmdb_id: number | null;
  tvdb_id: number | null;
  show_media_id: string | null;
  genres: string[] | null;
  /** Albums only, from that server's album row. */
  year?: number | null;
  thumb_path?: string | null;
  server_id?: string;
  added_at?: Date | string;
  track_count?: number;
}

interface ArtistAlbumRow {
  id: string;
  title: string;
  year: number | null;
  genres: string[] | null;
  thumb_path: string | null;
  server_id: string;
  added_at: Date | string;
  track_count: number;
}

/**
 * Album rows under an artist's active copies, one per server copy, newest
 * release first. Track counts come from the album's own server.
 */
async function getArtistAlbums(
  artistId: string,
  serverIds: string[] | undefined,
  scope: Scope
): Promise<ArtistAlbumRow[]> {
  const aliases = await resolveMediaAliases(artistId);
  const result = await db.execute(sql`
    SELECT
      a.media_id AS id,
      a.title,
      a.year,
      a.genres,
      a.thumb_path,
      a.server_id,
      a.created_at AS added_at,
      (
        SELECT COUNT(*)::int FROM library_items t
        WHERE t.server_id = a.server_id AND t.parent_rating_key = a.rating_key
          AND t.media_type = 'track' AND t.removed_at IS NULL
      ) AS track_count
    FROM library_items a
    JOIN library_items ar ON ar.server_id = a.server_id AND ar.rating_key = a.parent_rating_key
      AND ar.media_type = 'artist' AND ar.removed_at IS NULL
    WHERE a.media_type = 'album' AND a.removed_at IS NULL AND a.media_id IS NOT NULL
      AND ar.media_id IN (${idList(aliases.length > 0 ? aliases : [artistId])})
      ${libraryFragment(serverIds, scope, 'a')}
    ORDER BY a.year DESC NULLS LAST, a.title, a.server_id
  `);
  return result.rows as unknown as ArtistAlbumRow[];
}

interface ShowSeasonRow {
  id: string;
  season_number: number | null;
  title: string;
  year: number | null;
  episode_count: number;
}

/** Seasons of a show with their active episode counts, deduped across merges. */
async function getShowSeasons(
  showId: string,
  serverIds: string[] | undefined,
  scope: Scope
): Promise<ShowSeasonRow[]> {
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');

  const seasonRows = await db
    .select({ id: media.id, matchKey: media.matchKey, title: media.title, year: media.year })
    .from(media)
    .where(and(eq(media.mediaType, 'season'), eq(media.showMediaId, showId)));

  const countsRes = await db.execute(sql`
    SELECT li.parent_index AS season_number, COUNT(DISTINCT li.media_id) AS episode_count
    FROM library_items li
    JOIN media em ON em.id = li.media_id
    WHERE li.media_type = 'episode'
      AND em.show_media_id = ${showId}
      AND li.removed_at IS NULL
      AND li.parent_index IS NOT NULL
      ${serverFragmentLi}
    GROUP BY li.parent_index
  `);
  const countBySeason = new Map<number, number>();
  for (const r of countsRes.rows as unknown as {
    season_number: number;
    episode_count: string;
  }[]) {
    countBySeason.set(Number(r.season_number), Number(r.episode_count));
  }

  // Show merges leave duplicate season numbers; keep one per number, canonical key preferred
  const canonicalKeyPrefix = `season:${showId}:`;
  const rowBySeason = new Map<number, (typeof seasonRows)[number]>();
  const unnumbered: typeof seasonRows = [];
  for (const s of seasonRows) {
    const n = seasonNumberFromKey(s.matchKey);
    if (n === null) {
      unnumbered.push(s);
      continue;
    }
    const prev = rowBySeason.get(n);
    if (
      !prev ||
      (s.matchKey.startsWith(canonicalKeyPrefix) && !prev.matchKey.startsWith(canonicalKeyPrefix))
    ) {
      rowBySeason.set(n, s);
    }
  }

  return [...rowBySeason.values(), ...unnumbered]
    .map((s) => {
      const n = seasonNumberFromKey(s.matchKey);
      return {
        id: s.id,
        season_number: n,
        title: s.title,
        year: s.year,
        episode_count: n !== null ? (countBySeason.get(n) ?? 0) : 0,
      };
    })
    .sort((a, b) => (a.season_number ?? Infinity) - (b.season_number ?? Infinity));
}

/** Episodes of a single season, ordered by their item index (episode number). */
async function getEpisodesForSeason(
  showMediaId: string,
  seasonNumber: number,
  serverIds: string[] | undefined,
  scope: Scope
): Promise<EpisodeChildRow[]> {
  const serverFragmentLi = libraryFragment(serverIds, scope, 'li');
  const epRes = await db.execute(sql`
    SELECT
      em.id,
      em.title,
      em.imdb_id,
      em.tmdb_id,
      em.tvdb_id,
      em.show_media_id,
      em.genres,
      MAX(li.item_index) AS episode_number
    FROM library_items li
    JOIN media em ON em.id = li.media_id
    WHERE li.media_type = 'episode'
      AND li.parent_index = ${seasonNumber}
      AND em.show_media_id = ${showMediaId}
      AND li.removed_at IS NULL
      ${serverFragmentLi}
    GROUP BY em.id, em.title, em.imdb_id, em.tmdb_id, em.tvdb_id, em.show_media_id, em.genres
    ORDER BY MAX(li.item_index) ASC NULLS LAST
  `);
  return epRes.rows as unknown as EpisodeChildRow[];
}

/**
 * Seasons of a show, episodes of a season, or an artist's albums. Returns null
 * for media types with no children (movie/episode) - the caller 404s on null.
 * A season ref with no recoverable season number returns [] (matches v2: 200,
 * not 404).
 */
export async function getChildren(
  canonical: MediaDetailRow,
  serverIds: string[] | undefined,
  scope: Scope = 'all'
): Promise<MediaChildRow[] | null> {
  if (canonical.mediaType === 'show') {
    const seasons = await getShowSeasons(canonical.id, serverIds, scope);
    return seasons.map((s) => ({
      id: s.id,
      media_type: 'season' as const,
      title: s.title,
      season_number: s.season_number,
      episode_count: s.episode_count,
      episode_number: null,
      imdb_id: null,
      tmdb_id: null,
      tvdb_id: null,
      show_media_id: canonical.id,
      genres: null,
    }));
  }

  if (canonical.mediaType === 'season') {
    const n = seasonNumberFromKey(canonical.matchKey);
    if (n === null || !canonical.showMediaId) return [];

    const episodes = await getEpisodesForSeason(canonical.showMediaId, n, serverIds, scope);
    return episodes.map((e) => ({
      id: e.id,
      media_type: 'episode' as const,
      title: e.title,
      season_number: null,
      episode_count: null,
      episode_number: e.episode_number,
      imdb_id: e.imdb_id,
      tmdb_id: e.tmdb_id,
      tvdb_id: e.tvdb_id,
      show_media_id: e.show_media_id,
      genres: e.genres,
    }));
  }

  if (canonical.mediaType === 'artist') {
    const albums = await getArtistAlbums(canonical.id, serverIds, scope);
    return albums.map((a) => ({
      ...a,
      media_type: 'album' as const,
      season_number: null,
      episode_count: null,
      episode_number: null,
      imdb_id: null,
      tmdb_id: null,
      tvdb_id: null,
      show_media_id: null,
    }));
  }

  return null;
}

export interface SeasonHeatEpisodeRow {
  episode_number: number | null;
  watched_state: WatchedState;
}

export interface SeasonHeatSeasonRow {
  season_number: number | null;
  title: string;
  year: number | null;
  episodes: SeasonHeatEpisodeRow[];
}

/**
 * Per-episode watched state grouped by season, for the show detail page's
 * watch-heat strip. Whole-audience only (lensUserId: null, no lens param on
 * this endpoint) - the detail page has no per-viewer lens on its own stats
 * (owner decision, Task-18 GAP-B), so this aggregates plays across every
 * identity rather than a single viewer's history.
 *
 * Episode ids are passed through resolveWatchedStates' movieIds path rather
 * than a separate episode probe: that path resolves watched/partial purely
 * from a media id's own plays (BOOL_OR(any_watched)/BOOL_OR(counted) keyed on
 * media_id, no media_type predicate), which is exactly an episode's
 * direct-media state - the same shape the movieIds path already computes.
 */
export async function getSeasonHeat(
  canonical: MediaDetailRow,
  serverIds: string[] | undefined,
  lensUserId: string | null,
  scope: Scope = 'all'
): Promise<SeasonHeatSeasonRow[] | null> {
  if (canonical.mediaType !== 'show') return null;

  const seasons = await getShowSeasons(canonical.id, serverIds, scope);
  const seasonEpisodes = await Promise.all(
    seasons.map((s) =>
      s.season_number !== null
        ? getEpisodesForSeason(canonical.id, s.season_number, serverIds, scope)
        : Promise.resolve<EpisodeChildRow[]>([])
    )
  );

  const allEpisodeIds = seasonEpisodes.flat().map((e) => e.id);
  const watchedStates =
    allEpisodeIds.length > 0
      ? await resolveWatchedStates({
          movieIds: allEpisodeIds,
          showIds: [],
          serverIds,
          lensUserId,
          episodeCounts: new Map(),
        })
      : new Map<string, WatchedState>();

  return seasons.map((s, i) => ({
    season_number: s.season_number,
    title: s.title,
    year: s.year,
    episodes: seasonEpisodes[i]!.map((e) => ({
      episode_number: e.episode_number,
      watched_state: watchedStates.get(e.id) ?? 'unwatched',
    })),
  }));
}

interface StatsAggRow {
  server_id: string | null;
  plays: string | number;
  watch_time_ms: string | number;
  unique_users: number;
}

export interface MediaStatsWindowResult {
  combined: { plays: number; watch_time_ms: number; unique_users: number };
  per_server: {
    server_id: string;
    server_name: string | null;
    plays: number;
    watch_time_ms: number;
    unique_users: number;
  }[];
}

/**
 * Plays/watch time/unique-viewer rollup across all three stats windows.
 * Movies and episodes read the media_id rollup; shows roll up episodes via
 * show_media_id; seasons and artists compute live from raw sessions.
 */
export async function getMediaStats(
  scope: MediaScope,
  serverIds: string[] | undefined,
  rowScope: Scope
): Promise<Record<StatsWindowKey, MediaStatsWindowResult>> {
  const serverRows = await db.select({ id: servers.id, name: servers.name }).from(servers);
  const serverNames = new Map(serverRows.map((s) => [s.id, s.name]));

  const fromSessions = readsSessions(scope);
  const scopeFilter = fromSessions
    ? sql.join(scopeSessionConditions(scope), sql` AND `)
    : scope.kind === 'show'
      ? sql`p.show_media_id IN (${idList(scope.aliases)})`
      : sql`p.media_id IN (${idList(scope.aliases)})`;

  const windows: Record<StatsWindowKey, MediaStatsWindowResult> = {} as Record<
    StatsWindowKey,
    MediaStatsWindowResult
  >;
  for (const win of STATS_WINDOWS) {
    const alias = fromSessions ? 's' : 'p';
    const serverFragment = scopedServerFragment(
      serverIds,
      rowScope,
      `${alias}.server_id`,
      sql.raw(`${alias}.server_user_id`)
    );
    const result = fromSessions
      ? await db.execute(sql`
            SELECT
              s.server_id,
              COUNT(DISTINCT COALESCE(s.reference_id, s.id)) FILTER (WHERE ${countedSessionSql('s')}) AS plays,
              SUM(CASE WHEN ${countedSessionSql('s')} THEN s.duration_ms ELSE 0 END) AS watch_time_ms,
              COUNT(DISTINCT su.user_id) FILTER (WHERE ${countedSessionSql('s')})::int AS unique_users
            FROM sessions s
            JOIN server_users su ON su.id = s.server_user_id
            WHERE ${scopeFilter}${windowDayFilter(sql`s.started_at`, win.days)} ${serverFragment}
            GROUP BY GROUPING SETS ((s.server_id), ())
          `)
      : await db.execute(sql`
            SELECT
              p.server_id,
              COUNT(DISTINCT p.chain_id) FILTER (WHERE p.counted) AS plays,
              SUM(p.watched_ms) AS watch_time_ms,
              COUNT(DISTINCT su.user_id) FILTER (WHERE p.watched_ms > 0)::int AS unique_users
            FROM user_media_plays_daily p
            JOIN server_users su ON su.id = p.server_user_id
            WHERE ${scopeFilter}${windowDayFilter(sql`p.day`, win.days)} ${serverFragment}
            GROUP BY GROUPING SETS ((p.server_id), ())
          `);

    const rows = result.rows as unknown as StatsAggRow[];
    const combinedRow = rows.find((r) => r.server_id === null);
    const perServer = rows
      .filter((r) => r.server_id !== null)
      .map((r) => ({
        server_id: r.server_id as string,
        server_name: serverNames.get(r.server_id as string) ?? null,
        plays: Number(r.plays ?? 0),
        watch_time_ms: Number(r.watch_time_ms ?? 0),
        unique_users: Number(r.unique_users ?? 0),
      }));

    windows[win.key] = {
      combined: {
        plays: Number(combinedRow?.plays ?? 0),
        watch_time_ms: Number(combinedRow?.watch_time_ms ?? 0),
        unique_users: Number(combinedRow?.unique_users ?? 0),
      },
      per_server: perServer,
    };
  }

  return windows;
}

interface WatcherAggRow {
  server_user_id: string;
  user_id: string;
  server_id: string;
  username: string | null;
  identity_name: string | null;
  thumb: string | null;
  plays: string | number;
  watch_time_ms: string | number;
  completion_pct: number | null;
  last_watched_day: string | null;
  distinct_episodes_watched: number;
}

export interface MediaWatcherRow {
  user: {
    server_user_id: string;
    user_id: string;
    server_id: string;
    username: string | null;
    identity_name: string | null;
    thumb: string | null;
  };
  plays: number;
  watch_time_ms: number;
  completion_pct: number | null;
  last_watched_day: string | null;
  distinct_episodes_watched: number | null;
}

export interface GetMediaWatchersArgs {
  scope: MediaScope;
  windowKey: StatsWindowKey;
  serverId?: string;
  serverIds: string[] | undefined;
}

/** Per server-user rollup for a media item's scope, one entry per account. */
export async function getMediaWatchers(args: GetMediaWatchersArgs): Promise<MediaWatcherRow[]> {
  const { scope, windowKey, serverId, serverIds } = args;
  const days = STATS_WINDOWS.find((w) => w.key === windowKey)?.days ?? null;
  const isEpisodic = scope.kind === 'show' || scope.kind === 'season';

  let rows: WatcherAggRow[];
  if (readsSessions(scope)) {
    const serverFilter = serverId ? sql` AND s.server_id = ${serverId}` : sql``;
    const authFragment = buildMultiServerFragment(serverIds, 's.server_id');
    const result = await db.execute(sql`
      SELECT
        s.server_user_id,
        su.user_id,
        su.server_id,
        su.username,
        u.name AS identity_name,
        COALESCE(u.thumbnail, su.thumb_url) AS thumb,
        COUNT(DISTINCT COALESCE(s.reference_id, s.id)) FILTER (WHERE ${countedSessionSql('s')}) AS plays,
        SUM(CASE WHEN ${countedSessionSql('s')} THEN s.duration_ms ELSE 0 END) AS watch_time_ms,
        CASE WHEN MAX(s.progress_ms) IS NULL OR COALESCE(MAX(s.total_duration_ms), 0) = 0 THEN NULL
             ELSE LEAST(100, round(100.0 * MAX(s.progress_ms) / MAX(s.total_duration_ms), 1))
        END::float8 AS completion_pct,
        MAX((s.started_at AT TIME ZONE 'utc')::date)::text AS last_watched_day,
        COUNT(DISTINCT s.media_id) FILTER (WHERE ${countedSessionSql('s')})::int AS distinct_episodes_watched
      FROM sessions s
      JOIN server_users su ON su.id = s.server_user_id
      LEFT JOIN users u ON u.id = su.user_id
      WHERE ${sql.join(scopeSessionConditions(scope), sql` AND `)}${windowDayFilter(sql`s.started_at`, days)} ${serverFilter} ${authFragment}
      GROUP BY s.server_user_id, su.user_id, su.server_id, su.username, u.name, COALESCE(u.thumbnail, su.thumb_url)
      HAVING COUNT(DISTINCT COALESCE(s.reference_id, s.id)) FILTER (WHERE ${countedSessionSql('s')}) > 0
      ORDER BY watch_time_ms DESC, s.server_user_id
    `);
    rows = result.rows as unknown as WatcherAggRow[];
  } else {
    const scopeFilter =
      scope.kind === 'show'
        ? sql`p.show_media_id IN (${idList(scope.aliases)})`
        : sql`p.media_id IN (${idList(scope.aliases)})`;
    const serverFilter = serverId ? sql` AND p.server_id = ${serverId}` : sql``;
    const authFragment = buildMultiServerFragment(serverIds, 'p.server_id');
    const result = await db.execute(sql`
      SELECT
        p.server_user_id,
        su.user_id,
        su.server_id,
        su.username,
        u.name AS identity_name,
        COALESCE(u.thumbnail, su.thumb_url) AS thumb,
        COUNT(DISTINCT p.chain_id) FILTER (WHERE p.counted) AS plays,
        SUM(p.watched_ms) AS watch_time_ms,
        CASE WHEN MAX(p.max_progress_ms) IS NULL OR COALESCE(MAX(p.content_duration_ms), 0) = 0 THEN NULL
             ELSE LEAST(100, round(100.0 * MAX(p.max_progress_ms) / MAX(p.content_duration_ms), 1))
        END::float8 AS completion_pct,
        MAX((p.day AT TIME ZONE 'utc')::date)::text AS last_watched_day,
        COUNT(DISTINCT p.media_id) FILTER (WHERE p.counted)::int AS distinct_episodes_watched
      FROM user_media_plays_daily p
      JOIN server_users su ON su.id = p.server_user_id
      LEFT JOIN users u ON u.id = su.user_id
      WHERE ${scopeFilter}${windowDayFilter(sql`p.day`, days)} ${serverFilter} ${authFragment}
      GROUP BY p.server_user_id, su.user_id, su.server_id, su.username, u.name, COALESCE(u.thumbnail, su.thumb_url)
      HAVING BOOL_OR(p.counted)
      ORDER BY watch_time_ms DESC, p.server_user_id
    `);
    rows = result.rows as unknown as WatcherAggRow[];
  }

  return rows.map((r) => ({
    user: {
      server_user_id: r.server_user_id,
      user_id: r.user_id,
      server_id: r.server_id,
      username: r.username,
      identity_name: r.identity_name,
      thumb: r.thumb,
    },
    plays: Number(r.plays ?? 0),
    watch_time_ms: Number(r.watch_time_ms ?? 0),
    completion_pct: r.completion_pct,
    last_watched_day: r.last_watched_day,
    distinct_episodes_watched: isEpisodic ? Number(r.distinct_episodes_watched ?? 0) : null,
  }));
}

export interface GetMediaHistoryPageArgs {
  scope: MediaScope;
  pageSize: number;
  cursorValue: { startedAt: Date; id: string } | null;
  serverIds: string[] | undefined;
  rowScope: Scope;
}

/** Chain-grain watch history for a media item's scope, same paging as /history. */
export async function getMediaHistoryPage(
  args: GetMediaHistoryPageArgs
): Promise<Awaited<ReturnType<typeof runHistoryPage>>> {
  const { scope, pageSize, cursorValue, serverIds, rowScope } = args;
  const conditions = scopeSessionConditions(scope);
  const authCondition = serverIdCondition(serverIds, 's.server_id');
  if (authCondition) conditions.push(authCondition);
  const ownRows = scopeSessionsRaw(rowScope, sql`s.server_user_id`);
  if (ownRows) conditions.push(ownRows);
  return runHistoryPage(conditions, pageSize, cursorValue, undefined);
}

export interface MediaPlatformBreakdownRow {
  platform: string | null;
  player: string | null;
  plays: number;
  watch_time_ms: number;
}

/**
 * Sessions grouped by platform/player for a media item's scope. Shows and
 * seasons match their show's aliases on show_media_id (a season is not
 * filtered to itself), movies and episodes on media_id, artists their track
 * sessions; a session's media_id and show_media_id never hold the same value,
 * so matching either column is safe for the alias case.
 */
export async function getMediaPlatformBreakdown(
  scope: MediaScope,
  serverIds: string[] | undefined,
  rowScope: Scope
): Promise<MediaPlatformBreakdownRow[]> {
  const ids = uuidArraySql(scope.kind === 'season' ? scope.showAliases : scope.aliases);
  const scopeFilter =
    scope.kind === 'artist'
      ? sql.join(scopeSessionConditions(scope), sql` AND `)
      : sql`(s.media_id = ANY(${ids}) OR s.show_media_id = ANY(${ids}))`;
  const serverFragment = scopedServerFragment(
    serverIds,
    rowScope,
    's.server_id',
    sql`s.server_user_id`
  );
  const result = await db.execute(sql`
    SELECT
      s.platform,
      s.player_name AS player,
      COUNT(DISTINCT COALESCE(s.reference_id, s.id)) FILTER (WHERE ${countedSessionSql('s')}) AS plays,
      SUM(CASE WHEN ${countedSessionSql('s')} THEN s.duration_ms ELSE 0 END) AS watch_time_ms
    FROM sessions s
    WHERE ${scopeFilter}
      ${serverFragment}
    GROUP BY s.platform, s.player_name
    HAVING COUNT(DISTINCT COALESCE(s.reference_id, s.id)) FILTER (WHERE ${countedSessionSql('s')}) > 0
    ORDER BY plays DESC, lower(s.platform) NULLS LAST, lower(s.player_name) NULLS LAST
  `);
  return (
    result.rows as unknown as {
      platform: string | null;
      player: string | null;
      plays: string;
      watch_time_ms: string;
    }[]
  ).map((r) => ({
    platform: r.platform,
    player: r.player,
    plays: Number(r.plays),
    watch_time_ms: Number(r.watch_time_ms),
  }));
}
