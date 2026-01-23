/**
 * Watch Sync Matcher
 *
 * Media matching logic for cross-server watch status synchronization.
 * Uses provider IDs (IMDB, TMDB, TVDB) as primary matching mechanism.
 */

import type { WatchedItem } from '@tracearr/shared';

/**
 * Normalize a title for fallback comparison
 * - Lowercase
 * - Remove punctuation
 * - Trim whitespace
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Match a source item to target items using provider IDs
 *
 * Matching priority:
 * 1. IMDB ID exact match
 * 2. TMDB ID exact match
 * 3. TVDB ID exact match
 * 4. For episodes: Show TVDB + Season + Episode number
 * 5. Fallback: Normalized title + year (movies) or show+season+episode (episodes)
 *
 * @param sourceItem - The item to find a match for
 * @param targetItems - Available items on the target server
 * @returns The matching target item, or null if no match found
 */
export function matchItem(sourceItem: WatchedItem, targetItems: WatchedItem[]): WatchedItem | null {
  if (sourceItem.type === 'movie') {
    return matchMovie(sourceItem, targetItems);
  } else {
    return matchEpisode(sourceItem, targetItems);
  }
}

/**
 * Match a movie by provider IDs or fallback to title+year
 */
function matchMovie(sourceItem: WatchedItem, targetItems: WatchedItem[]): WatchedItem | null {
  const movieTargets = targetItems.filter((t) => t.type === 'movie');

  // Priority 1: IMDB ID match
  if (sourceItem.imdbId) {
    const match = movieTargets.find((t) => t.imdbId === sourceItem.imdbId);
    if (match) return match;
  }

  // Priority 2: TMDB ID match
  if (sourceItem.tmdbId) {
    const match = movieTargets.find((t) => t.tmdbId === sourceItem.tmdbId);
    if (match) return match;
  }

  // Priority 3: TVDB ID match (less common for movies, but some use it)
  if (sourceItem.tvdbId) {
    const match = movieTargets.find((t) => t.tvdbId === sourceItem.tvdbId);
    if (match) return match;
  }

  // Fallback: Normalized title + year
  if (sourceItem.title && sourceItem.year) {
    const normalizedSourceTitle = normalizeTitle(sourceItem.title);
    const match = movieTargets.find((t) => {
      if (!t.title || !t.year) return false;
      return normalizeTitle(t.title) === normalizedSourceTitle && t.year === sourceItem.year;
    });
    if (match) return match;
  }

  // Fallback: Just normalized title (no year)
  if (sourceItem.title) {
    const normalizedSourceTitle = normalizeTitle(sourceItem.title);
    const match = movieTargets.find((t) => {
      if (!t.title) return false;
      return normalizeTitle(t.title) === normalizedSourceTitle;
    });
    if (match) return match;
  }

  return null;
}

/**
 * Match an episode by provider IDs and episode info
 */
function matchEpisode(sourceItem: WatchedItem, targetItems: WatchedItem[]): WatchedItem | null {
  const episodeTargets = targetItems.filter((t) => t.type === 'episode');

  // Episode matching requires season and episode numbers
  const hasEpisodeInfo =
    sourceItem.seasonNumber !== undefined && sourceItem.episodeNumber !== undefined;

  // Priority 1: IMDB ID match (episode-level IMDB)
  if (sourceItem.imdbId) {
    const match = episodeTargets.find((t) => t.imdbId === sourceItem.imdbId);
    if (match) return match;
  }

  // Priority 2: TMDB ID match (episode-level TMDB)
  if (sourceItem.tmdbId) {
    const match = episodeTargets.find((t) => t.tmdbId === sourceItem.tmdbId);
    if (match) return match;
  }

  // Priority 3: TVDB ID match (episode-level TVDB)
  if (sourceItem.tvdbId) {
    const match = episodeTargets.find((t) => t.tvdbId === sourceItem.tvdbId);
    if (match) return match;
  }

  // Priority 4: Show TVDB/TMDB/IMDB + Season + Episode
  if (hasEpisodeInfo) {
    // Try show TVDB ID
    if (sourceItem.showTvdbId) {
      const match = episodeTargets.find(
        (t) =>
          t.showTvdbId === sourceItem.showTvdbId &&
          t.seasonNumber === sourceItem.seasonNumber &&
          t.episodeNumber === sourceItem.episodeNumber
      );
      if (match) return match;
    }

    // Try show TMDB ID
    if (sourceItem.showTmdbId) {
      const match = episodeTargets.find(
        (t) =>
          t.showTmdbId === sourceItem.showTmdbId &&
          t.seasonNumber === sourceItem.seasonNumber &&
          t.episodeNumber === sourceItem.episodeNumber
      );
      if (match) return match;
    }

    // Try show IMDB ID
    if (sourceItem.showImdbId) {
      const match = episodeTargets.find(
        (t) =>
          t.showImdbId === sourceItem.showImdbId &&
          t.seasonNumber === sourceItem.seasonNumber &&
          t.episodeNumber === sourceItem.episodeNumber
      );
      if (match) return match;
    }
  }

  // Fallback: Normalized show title + season + episode
  if (hasEpisodeInfo && sourceItem.showTitle) {
    const normalizedShowTitle = normalizeTitle(sourceItem.showTitle);
    const match = episodeTargets.find((t) => {
      if (!t.showTitle) return false;
      return (
        normalizeTitle(t.showTitle) === normalizedShowTitle &&
        t.seasonNumber === sourceItem.seasonNumber &&
        t.episodeNumber === sourceItem.episodeNumber
      );
    });
    if (match) return match;
  }

  return null;
}

/**
 * Compare two watched items and decide if source is better than target.
 * Mirrors JellyPlex-Watched conflict resolution ordering.
 */
export function compareWatchedItems(source: WatchedItem, target: WatchedItem): number {
  // If both are completed, it's a tie.
  if (source.completed && target.completed) {
    return 0;
  }

  // Next, compare completed status.
  if (source.completed !== target.completed) {
    return source.completed ? 1 : -1;
  }

  // For in-progress items, compare progress time only.
  if (!source.completed && !target.completed) {
    if (source.progressMs !== target.progressMs) {
      return source.progressMs > target.progressMs ? 1 : -1;
    }
    return 0;
  }

  // Fallback: compare viewedAt timestamps when both present and different.
  if (source.viewedAt && target.viewedAt) {
    const sourceTime = new Date(source.viewedAt).getTime();
    const targetTime = new Date(target.viewedAt).getTime();
    if (!Number.isNaN(sourceTime) && !Number.isNaN(targetTime) && sourceTime !== targetTime) {
      return sourceTime > targetTime ? 1 : -1;
    }
  }

  return 0;
}

/**
 * Determine if source should update target (conflict resolution)
 *
 * Rules (JellyPlex-Watched order):
 * - If target doesn't exist, sync the source
 * - Completed status wins
 * - Progress time wins
 * - viewedAt is only used as a fallback tie-breaker
 */
export function shouldSync(source: WatchedItem, target: WatchedItem | null): boolean {
  if (!target) {
    return true;
  }

  return compareWatchedItems(source, target) > 0;
}

/**
 * Build a lookup map for faster matching
 *
 * Creates maps indexed by various provider IDs for O(1) lookup instead of O(n) search.
 * Stores arrays of items per key to support syncing to ALL matching copies (e.g., same movie in multiple libraries).
 */
export function buildMatchLookup(items: WatchedItem[]): {
  byImdbId: Map<string, WatchedItem[]>;
  byTmdbId: Map<number, WatchedItem[]>;
  byTvdbId: Map<number, WatchedItem[]>;
  byShowTvdbIdAndEpisode: Map<string, WatchedItem[]>;
  byShowTmdbIdAndEpisode: Map<string, WatchedItem[]>;
  byFileName: Map<string, WatchedItem[]>;
  byTitleAndYear: Map<string, WatchedItem[]>;
  byTitle: Map<string, WatchedItem[]>;
  byShowTitleAndEpisode: Map<string, WatchedItem[]>;
} {
  const byImdbId = new Map<string, WatchedItem[]>();
  const byTmdbId = new Map<number, WatchedItem[]>();
  const byTvdbId = new Map<number, WatchedItem[]>();
  const byShowTvdbIdAndEpisode = new Map<string, WatchedItem[]>();
  const byShowTmdbIdAndEpisode = new Map<string, WatchedItem[]>();
  const byFileName = new Map<string, WatchedItem[]>();
  const byTitleAndYear = new Map<string, WatchedItem[]>();
  const byTitle = new Map<string, WatchedItem[]>();
  const byShowTitleAndEpisode = new Map<string, WatchedItem[]>();

  const addToList = <K>(map: Map<K, WatchedItem[]>, key: K, item: WatchedItem) => {
    const existing = map.get(key);
    if (existing) {
      existing.push(item);
    } else {
      map.set(key, [item]);
    }
  };

  for (const item of items) {
    // Provider ID indexes
    if (item.imdbId) {
      addToList(byImdbId, item.imdbId, item);
    }
    if (item.tmdbId) {
      addToList(byTmdbId, item.tmdbId, item);
    }
    if (item.tvdbId) {
      addToList(byTvdbId, item.tvdbId, item);
    }

    if (item.fileNames && item.fileNames.length > 0) {
      for (const fileName of item.fileNames) {
        addToList(byFileName, fileName.toLowerCase(), item);
      }
    }

    if (item.type === 'movie') {
      // Movie title + year index
      if (item.title && item.year) {
        addToList(byTitleAndYear, `${normalizeTitle(item.title)}|${item.year}`, item);
      }
      if (item.title) {
        addToList(byTitle, normalizeTitle(item.title), item);
      }
    } else {
      // Episode show + season + episode indexes
      if (item.showTvdbId && item.seasonNumber !== undefined && item.episodeNumber !== undefined) {
        addToList(
          byShowTvdbIdAndEpisode,
          `tvdb:${item.showTvdbId}|s${item.seasonNumber}e${item.episodeNumber}`,
          item
        );
      }
      if (item.showTmdbId && item.seasonNumber !== undefined && item.episodeNumber !== undefined) {
        addToList(
          byShowTmdbIdAndEpisode,
          `tmdb:${item.showTmdbId}|s${item.seasonNumber}e${item.episodeNumber}`,
          item
        );
      }
      if (item.showTitle && item.seasonNumber !== undefined && item.episodeNumber !== undefined) {
        addToList(
          byShowTitleAndEpisode,
          `${normalizeTitle(item.showTitle)}|s${item.seasonNumber}e${item.episodeNumber}`,
          item
        );
      }
    }
  }

  return {
    byImdbId,
    byTmdbId,
    byTvdbId,
    byShowTvdbIdAndEpisode,
    byShowTmdbIdAndEpisode,
    byFileName,
    byTitleAndYear,
    byTitle,
    byShowTitleAndEpisode,
  };
}

/**
 * Fast match using pre-built lookup maps
 * Returns ALL matching items (for syncing to multiple copies in different libraries)
 */
export function matchItemFast(
  sourceItem: WatchedItem,
  lookup: ReturnType<typeof buildMatchLookup>
): WatchedItem[] {
  const matches: WatchedItem[] = [];
  const seenIds = new Set<string>(); // Avoid duplicates

  const addMatches = (items: WatchedItem[] | undefined) => {
    if (!items) return;
    for (const item of items) {
      if (item.type === sourceItem.type && !seenIds.has(item.serverItemId)) {
        seenIds.add(item.serverItemId);
        matches.push(item);
      }
    }
  };

  // Try provider IDs first (these are most reliable)
  if (sourceItem.imdbId) {
    addMatches(lookup.byImdbId.get(sourceItem.imdbId));
  }
  if (sourceItem.tmdbId) {
    addMatches(lookup.byTmdbId.get(sourceItem.tmdbId));
  }
  if (sourceItem.tvdbId) {
    addMatches(lookup.byTvdbId.get(sourceItem.tvdbId));
  }

  // Add file-name matches (helps when duplicate libraries lack provider IDs)
  if (sourceItem.fileNames && sourceItem.fileNames.length > 0) {
    for (const fileName of sourceItem.fileNames) {
      addMatches(lookup.byFileName.get(fileName.toLowerCase()));
    }
  }

  // If we found matches by provider ID or file name, return them (don't fall back to title matching)
  if (matches.length > 0) {
    return matches;
  }

  // Fallback to title matching only if no provider ID matches
  if (sourceItem.type === 'movie') {
    // Try title + year
    if (sourceItem.title && sourceItem.year) {
      const key = `${normalizeTitle(sourceItem.title)}|${sourceItem.year}`;
      addMatches(lookup.byTitleAndYear.get(key));
    }
    if (matches.length === 0 && sourceItem.title) {
      const key = normalizeTitle(sourceItem.title);
      addMatches(lookup.byTitle.get(key));
    }
  } else {
    // Try show ID + episode
    if (
      sourceItem.showTvdbId &&
      sourceItem.seasonNumber !== undefined &&
      sourceItem.episodeNumber !== undefined
    ) {
      const key = `tvdb:${sourceItem.showTvdbId}|s${sourceItem.seasonNumber}e${sourceItem.episodeNumber}`;
      addMatches(lookup.byShowTvdbIdAndEpisode.get(key));
    }

    if (
      sourceItem.showTmdbId &&
      sourceItem.seasonNumber !== undefined &&
      sourceItem.episodeNumber !== undefined
    ) {
      const key = `tmdb:${sourceItem.showTmdbId}|s${sourceItem.seasonNumber}e${sourceItem.episodeNumber}`;
      addMatches(lookup.byShowTmdbIdAndEpisode.get(key));
    }

    // Try show title + episode (fallback)
    if (
      matches.length === 0 &&
      sourceItem.showTitle &&
      sourceItem.seasonNumber !== undefined &&
      sourceItem.episodeNumber !== undefined
    ) {
      const key = `${normalizeTitle(sourceItem.showTitle)}|s${sourceItem.seasonNumber}e${sourceItem.episodeNumber}`;
      addMatches(lookup.byShowTitleAndEpisode.get(key));
    }
  }

  return matches;
}
