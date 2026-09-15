import type { MediaRequestMediaType, RequestSeason, WatchedState } from '@tracearr/shared';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { fetchEpisodeCounts, resolveWatchedStates } from '../library/mediaWatchedService.js';

const WATCHED_PROBE_CONCURRENCY = 4;

export interface WatchedLensRow {
  id: string;
  mediaId: string | null;
  mediaType: MediaRequestMediaType;
  lensUserId: string | null;
  /** Null or empty means the whole show. */
  seasons: RequestSeason[] | null;
}

/** A probe carries one season restriction, so rows only batch together when they asked for the same seasons. */
function seasonKeyOf(seasons: RequestSeason[] | null): string {
  if (!seasons || seasons.length === 0) return 'all';
  return [...new Set(seasons.map((s) => s.seasonNumber))].sort((a, b) => a - b).join(',');
}

function seasonsFromKey(key: string): number[] | undefined {
  return key === 'all' ? undefined : key.split(',').map(Number);
}

export interface RequestWatchedLenses {
  anyone: WatchedState;
  requester: WatchedState;
}

export const UNWATCHED_LENSES: RequestWatchedLenses = {
  anyone: 'unwatched',
  requester: 'unwatched',
};

function mediaIdsOf(rows: WatchedLensRow[], kind: MediaRequestMediaType): string[] {
  return [
    ...new Set(
      rows.filter((r) => r.mediaType === kind).flatMap((r) => (r.mediaId ? [r.mediaId] : []))
    ),
  ];
}

/** One anyone-grain probe over every matched title, plus one requester-grain probe per requester identity. */
export async function watchedStatesFor(
  rows: WatchedLensRow[],
  serverIds: string[] | undefined
): Promise<Map<string, RequestWatchedLenses>> {
  const out = new Map<string, RequestWatchedLenses>();
  // Keyed `anyone|<seasonKey>` or `<lensUserId>|<seasonKey>`.
  const groups = new Map<
    string,
    { seasonKey: string; lensUserId: string | null; rows: WatchedLensRow[] }
  >();
  const add = (key: string, seasonKey: string, lensUserId: string | null, row: WatchedLensRow) => {
    const group = groups.get(key) ?? { seasonKey, lensUserId, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  };

  for (const row of rows) {
    out.set(row.id, { anyone: 'unwatched', requester: 'unwatched' });
    if (!row.mediaId) continue;
    const seasonKey = seasonKeyOf(row.seasons);
    add(`anyone|${seasonKey}`, seasonKey, null, row);
    if (row.lensUserId) add(`${row.lensUserId}|${seasonKey}`, seasonKey, row.lensUserId, row);
  }

  if (groups.size === 0) return out;

  // The denominator moves with the season restriction, so one query per distinct season list.
  const showsBySeasonKey = new Map<string, Set<string>>();
  for (const group of groups.values()) {
    const shows = showsBySeasonKey.get(group.seasonKey) ?? new Set<string>();
    for (const id of mediaIdsOf(group.rows, 'show')) shows.add(id);
    showsBySeasonKey.set(group.seasonKey, shows);
  }
  const countsBySeasonKey = new Map<string, Map<string, number>>(
    await mapWithConcurrency(
      [...showsBySeasonKey],
      WATCHED_PROBE_CONCURRENCY,
      async ([seasonKey, shows]): Promise<[string, Map<string, number>]> => [
        seasonKey,
        await fetchEpisodeCounts([...shows], serverIds, seasonsFromKey(seasonKey)),
      ]
    )
  );

  const probed = await mapWithConcurrency(
    [...groups.entries()],
    WATCHED_PROBE_CONCURRENCY,
    async ([key, group]) => ({
      key,
      group,
      states: await resolveWatchedStates({
        movieIds: mediaIdsOf(group.rows, 'movie'),
        showIds: mediaIdsOf(group.rows, 'show'),
        serverIds,
        lensUserId: group.lensUserId,
        episodeCounts: countsBySeasonKey.get(group.seasonKey) ?? new Map<string, number>(),
        seasons: seasonsFromKey(group.seasonKey),
      }),
    })
  );

  for (const { key, group, states } of probed) {
    const grain = key.startsWith('anyone|') ? 'anyone' : 'requester';
    for (const row of group.rows) {
      const entry = out.get(row.id);
      if (entry && row.mediaId) entry[grain] = states.get(row.mediaId) ?? 'unwatched';
    }
  }
  return out;
}
