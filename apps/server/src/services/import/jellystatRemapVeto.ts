/**
 * Jellystat item id selection and remap veto
 *
 * Jellystat's migrateArchivedActivty rewrites an activity's item id to a
 * current item with the same name once the original is archived. The backup's
 * library tables are the only record of that, so they decide which ids an
 * imported play may be linked through. Names and years here only ever
 * refuse a link.
 */

import type {
  JellystatLibraryEpisode,
  JellystatLibraryItem,
  JellystatPlaybackActivity,
  JellystatPluginRow,
} from '@tracearr/shared';
import type { SessionIdentity } from '../../jobs/poller/database.js';

interface JellystatRemapIndex {
  itemsById: Map<string, JellystatLibraryItem> | null;
  archivedItemsByName: Map<string, JellystatLibraryItem[]> | null;
  /** EpisodeId repeats: rows are keyed on EpisodeId + SeasonId, so a season change leaves one */
  episodesById: Map<string, JellystatLibraryEpisode[]> | null;
  /** SeriesName -> episode Name -> archived episodes */
  archivedEpisodesByName: Map<string, Map<string, JellystatLibraryEpisode[]>> | null;
  archivedNullSeriesEpisodesByName: Map<string, JellystatLibraryEpisode[]> | null;
  pluginItemIdByRowid: Map<number, string> | null;
}

interface JellystatItemKeyChoice {
  candidates: [string, ...string[]];
  source: 'plugin' | 'native';
  checked: boolean;
  /** The backup left out jf_library_episodes, so an episode play is keyed on its series id */
  episodeIdDropped?: boolean;
}

function pushTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function buildJellystatRemapIndex(
  items: JellystatLibraryItem[] | null,
  episodes: JellystatLibraryEpisode[] | null,
  pluginRows: JellystatPluginRow[] | null
): JellystatRemapIndex {
  let itemsById: JellystatRemapIndex['itemsById'] = null;
  let archivedItemsByName: JellystatRemapIndex['archivedItemsByName'] = null;
  if (items) {
    itemsById = new Map();
    archivedItemsByName = new Map();
    for (const item of items) {
      itemsById.set(item.Id, item);
      if (item.archived) pushTo(archivedItemsByName, item.Name, item);
    }
  }

  let episodesById: JellystatRemapIndex['episodesById'] = null;
  let archivedEpisodesByName: JellystatRemapIndex['archivedEpisodesByName'] = null;
  let archivedNullSeriesEpisodesByName: JellystatRemapIndex['archivedNullSeriesEpisodesByName'] =
    null;
  if (episodes) {
    episodesById = new Map();
    archivedEpisodesByName = new Map();
    archivedNullSeriesEpisodesByName = new Map();
    for (const episode of episodes) {
      pushTo(episodesById, episode.EpisodeId, episode);
      if (!episode.archived) continue;
      if (episode.SeriesName === null) {
        pushTo(archivedNullSeriesEpisodesByName, episode.Name, episode);
        continue;
      }
      let byName = archivedEpisodesByName.get(episode.SeriesName);
      if (!byName) {
        byName = new Map();
        archivedEpisodesByName.set(episode.SeriesName, byName);
      }
      pushTo(byName, episode.Name, episode);
    }
  }

  const pluginItemIdByRowid = pluginRows
    ? new Map(pluginRows.map((row) => [row.rowid, row.ItemId]))
    : null;

  return {
    itemsById,
    archivedItemsByName,
    episodesById,
    archivedEpisodesByName,
    archivedNullSeriesEpisodesByName,
    pluginItemIdByRowid,
  };
}

/**
 * Ordered item ids to try for a play's identity. `checked` is false only when
 * the backup left out the library table for the play's kind: jf_library_items
 * for a movie or other item, jf_library_episodes for an episode. A plugin row
 * is always checked.
 */
export function chooseJellystatItemKey(
  activity: JellystatPlaybackActivity,
  index: JellystatRemapIndex
): JellystatItemKeyChoice {
  if (activity.imported === true && index.pluginItemIdByRowid) {
    const pluginItemId = index.pluginItemIdByRowid.get(Number(activity.Id));
    if (pluginItemId !== undefined) {
      return { candidates: [pluginItemId], source: 'plugin', checked: true };
    }
  }

  if (activity.EpisodeId) {
    // A rewrite that leaves this shape stores a series id in NowPlayingItemId, which never links.
    if (activity.imported === true && hasConcatenatedEpisodeId(activity)) {
      return {
        candidates: [activity.NowPlayingItemId],
        source: 'native',
        checked: index.episodesById !== null,
      };
    }
    if (!index.episodesById) {
      return {
        candidates: [activity.NowPlayingItemId],
        source: 'native',
        checked: false,
        episodeIdDropped: activity.EpisodeId !== activity.NowPlayingItemId,
      };
    }
    return {
      candidates: [activity.EpisodeId, activity.NowPlayingItemId],
      source: 'native',
      checked: true,
    };
  }

  return {
    candidates: [activity.NowPlayingItemId],
    source: 'native',
    checked: index.itemsById !== null,
  };
}

/**
 * The single id a play is stored and linked under: the first candidate that
 * resolves, else the fallback key. A native EpisodeId only counts when it
 * resolves to an episode, and one that resolves to anything else is never
 * used as the fallback either.
 */
export function resolveJellystatItemKey(
  choice: JellystatItemKeyChoice,
  identityByRatingKey: Map<string, SessionIdentity>
): { ratingKey: string; identity: SessionIdentity | undefined } {
  const [first, ...rest] = choice.candidates;
  const hasEpisodeCandidate = choice.source === 'native' && rest.length > 0;
  let fallback = first;

  for (const candidate of choice.candidates) {
    const identity = identityByRatingKey.get(candidate);
    if (!identity) continue;
    if (hasEpisodeCandidate && candidate === first && identity.itemMediaType !== 'episode') {
      fallback = rest[rest.length - 1] ?? first;
      continue;
    }
    return { ratingKey: candidate, identity };
  }

  return { ratingKey: fallback, identity: undefined };
}

/** Migration 045/065/068 plugin rows stored EpisodeId as the episode id + SeasonId. */
function hasConcatenatedEpisodeId(activity: JellystatPlaybackActivity): boolean {
  return (
    !!activity.SeasonId && activity.EpisodeId === activity.NowPlayingItemId + activity.SeasonId
  );
}

/** Migration 093 plugin rows store EpisodeId equal to NowPlayingItemId; older ones concatenate. */
function hasPluginImportEpisodeIds(activity: JellystatPlaybackActivity): boolean {
  return activity.EpisodeId === activity.NowPlayingItemId || hasConcatenatedEpisodeId(activity);
}

/** A plugin-origin episode row handled as native whose ids the episode remap rewrote. */
export function isImportedEpisodeRowRewritten(
  activity: JellystatPlaybackActivity,
  choice: JellystatItemKeyChoice
): boolean {
  if (activity.imported !== true || choice.source !== 'native' || !activity.EpisodeId) {
    return false;
  }
  return !hasPluginImportEpisodeIds(activity);
}

function yearsDiffer(a: number | null, b: number | null): boolean {
  return a === null || b === null || a !== b;
}

function episodesMayDiffer(
  original: JellystatLibraryEpisode,
  target: JellystatLibraryEpisode,
  index: JellystatRemapIndex
): boolean {
  if (
    original.ParentIndexNumber === null ||
    original.IndexNumber === null ||
    target.ParentIndexNumber === null ||
    target.IndexNumber === null ||
    original.ParentIndexNumber !== target.ParentIndexNumber ||
    original.IndexNumber !== target.IndexNumber
  ) {
    return true;
  }
  const originalSeries = original.SeriesId ? index.itemsById?.get(original.SeriesId) : undefined;
  const targetSeries = target.SeriesId ? index.itemsById?.get(target.SeriesId) : undefined;
  return (
    !originalSeries ||
    !targetSeries ||
    yearsDiffer(originalSeries.ProductionYear, targetSeries.ProductionYear)
  );
}

export function isRemapVetoed(
  activity: JellystatPlaybackActivity,
  chosenId: string,
  isEpisode: boolean,
  index: JellystatRemapIndex
): boolean {
  if (!isEpisode) {
    const archived = index.archivedItemsByName?.get(activity.NowPlayingItemName) ?? [];
    const target = index.itemsById?.get(chosenId);
    return archived.some(
      (original) =>
        original.Id !== chosenId &&
        (!target || yearsDiffer(original.ProductionYear, target.ProductionYear))
    );
  }

  if (activity.imported === true && hasPluginImportEpisodeIds(activity)) return false;
  // Jellystat's UPDATE rewrites every play on the old EpisodeId, whatever that play's SeriesName.
  if (activity.SeriesName == null) return true;
  const originals = [
    ...(index.archivedEpisodesByName?.get(activity.SeriesName)?.get(activity.NowPlayingItemName) ??
      []),
    ...(index.archivedNullSeriesEpisodesByName?.get(activity.NowPlayingItemName) ?? []),
  ];
  const targets = index.episodesById?.get(chosenId) ?? [];

  return originals.some(
    (original) =>
      original.EpisodeId !== chosenId &&
      (targets.length === 0 || targets.some((target) => episodesMayDiffer(original, target, index)))
  );
}
