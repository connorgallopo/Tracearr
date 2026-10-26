/**
 * What a library sync announces: the items it inserted, and the ones whose quality
 * signature moved. The diff is pure so the sync can run it after its transaction
 * commits. Changes are held until the whole run finishes, because a season and its
 * episodes reach the upsert from different passes and only read as one drop together.
 */

import {
  dispatchMediaAdded,
  dispatchMediaUpgraded,
  mediaListeners,
} from '../automations/events/producers.js';
import { MEDIA_QUALITY_FIELDS } from '../automations/types.js';
import type { EvaluationServer } from '../automations/events/types.js';
import type { MediaQuality, MediaSubject } from '../automations/types.js';

/** Items one sync run may announce before it goes quiet; a rebuilt library is not news. */
export const MEDIA_ANNOUNCE_CAP = 20;

/**
 * Changes one run holds while it waits to collapse them. Well above the announce cap so a
 * season's episodes are all present to be swallowed, and bounded so a mass upgrade cannot
 * grow the buffer without limit.
 */
export const MEDIA_BUFFER_CAP = 2000;

/** Shared by every library of one sync run, so a whole-server rescan cannot flood. */
export interface MediaAnnounceBudget {
  remaining: number;
  suppressed: number;
}

/** The server being synced, and everything its libraries have collected so far. */
export interface MediaAnnounceRun {
  server: EvaluationServer;
  budget: MediaAnnounceBudget;
  collected: CollectedChange[];
}

/** The media triggers something listens for; a kind nobody hears never takes an announce slot. */
export interface MediaListening {
  added: boolean;
  upgraded: boolean;
}

/** One library's announce context, as `upsertItems` receives it. */
export interface MediaAnnounce {
  server: EvaluationServer;
  libraryName: string;
  budget: MediaAnnounceBudget;
  run: MediaAnnounceRun;
  listening: MediaListening;
}

/** The quality a row held before the upsert, keyed by rating key. */
export interface PriorMediaRow {
  quality: MediaQuality;
}

/** A row the upsert changed, with the values it now holds. */
export interface SyncedMediaRow {
  id: string;
  ratingKey: string;
  mediaId: string | null;
  firstSeenAt: Date | null;
  title: string;
  grandparentTitle: string | null;
  parentTitle: string | null;
  grandparentRatingKey: string | null;
  parentRatingKey: string | null;
  parentIndex: number | null;
  itemIndex: number | null;
  mediaType: string;
  year: number | null;
  imdbId: string | null;
  tmdbId: number | null;
  tvdbId: number | null;
  thumbPath: string | null;
  quality: MediaQuality;
}

export type MediaChange =
  | { kind: 'added'; row: SyncedMediaRow }
  | { kind: 'upgraded'; row: SyncedMediaRow; from: MediaQuality; changed: (keyof MediaQuality)[] };

/** A change plus the library it came from, since the buffer spans every library of a run. */
export interface CollectedChange {
  change: MediaChange;
  libraryId: string;
  libraryName: string;
}

/** What survives the collapse: a change, and the episode count if a season absorbed any. */
export interface AnnouncedChange {
  collected: CollectedChange;
  addedEpisodeCount?: number;
}

export function createAnnounceRun(server: EvaluationServer): MediaAnnounceRun {
  return { server, budget: { remaining: MEDIA_ANNOUNCE_CAP, suppressed: 0 }, collected: [] };
}

/**
 * The context for one library, or null when there is nothing to announce: a first
 * sync would announce the whole library, and no listener means no diff to pay for.
 */
export async function createMediaAnnounce(args: {
  run: MediaAnnounceRun;
  libraryName: string;
  isFirstSync: () => Promise<boolean>;
}): Promise<MediaAnnounce | null> {
  const listening = await mediaListeners(args.run.server.id);
  if (!listening.added && !listening.upgraded) return null;
  if (await args.isFirstSync()) return null;
  return {
    server: args.run.server,
    libraryName: args.libraryName,
    budget: args.run.budget,
    run: args.run,
    listening,
  };
}

/** A field counts only when both sides hold a value: a column arriving is not an upgrade. */
function changedFields(before: MediaQuality, after: MediaQuality): (keyof MediaQuality)[] {
  return MEDIA_QUALITY_FIELDS.filter(
    (field) => before[field] !== null && after[field] !== null && before[field] !== after[field]
  );
}

function changeOf(
  row: SyncedMediaRow,
  prior: PriorMediaRow | undefined,
  firstSeen: Date,
  listening: MediaListening
): MediaChange | null {
  // first_seen_at is insert-only, so carrying this call's stamp is exactly a fresh insert.
  if (row.firstSeenAt?.getTime() === firstSeen.getTime()) {
    return listening.added ? { kind: 'added', row } : null;
  }
  if (!prior || !listening.upgraded) return null;
  const changed = changedFields(prior.quality, row.quality);
  if (changed.length === 0) return null;
  return { kind: 'upgraded', row, from: prior.quality, changed };
}

/** The changes worth announcing, capped at the room the caller still has. */
export function diffMediaChanges(args: {
  rows: readonly SyncedMediaRow[];
  prior: ReadonlyMap<string, PriorMediaRow>;
  firstSeen: Date;
  budget: number;
  listening: MediaListening;
}): { changes: MediaChange[]; suppressed: number } {
  const changes: MediaChange[] = [];
  let suppressed = 0;

  for (const row of args.rows) {
    const change = changeOf(row, args.prior.get(row.ratingKey), args.firstSeen, args.listening);
    if (!change) continue;
    if (changes.length >= args.budget) {
      suppressed += 1;
      continue;
    }
    changes.push(change);
  }

  return { changes, suppressed };
}

/**
 * Runs after the upsert commits: the run holds what changed until every library is done.
 * Nothing dispatches here, so a season arriving after its episodes can still absorb them.
 */
export function collectMediaChanges(args: {
  announce: MediaAnnounce;
  libraryId: string;
  rows: readonly SyncedMediaRow[];
  prior: ReadonlyMap<string, PriorMediaRow>;
  firstSeen: Date;
}): void {
  const { announce, libraryId, rows, prior, firstSeen } = args;
  const { run } = announce;
  const { changes, suppressed } = diffMediaChanges({
    rows,
    prior,
    firstSeen,
    budget: MEDIA_BUFFER_CAP - run.collected.length,
    listening: announce.listening,
  });
  run.budget.suppressed += suppressed;
  for (const change of changes) {
    run.collected.push({ change, libraryId, libraryName: announce.libraryName });
  }
}

/**
 * Whether an episode sits under a season. Plex and — since the parser reads SeasonId —
 * Jellyfin and Emby key episodes to their season; the show-plus-number match covers rows
 * written before that, whose parent rating key is still null.
 */
function belongsToSeason(episode: SyncedMediaRow, season: SyncedMediaRow): boolean {
  if (episode.parentRatingKey !== null && episode.parentRatingKey === season.ratingKey) return true;
  return (
    episode.grandparentRatingKey !== null &&
    episode.grandparentRatingKey === season.parentRatingKey &&
    episode.parentIndex !== null &&
    episode.parentIndex === season.parentIndex
  );
}

/** Whether a season sits under a show, so a new show does not announce alongside its seasons. */
function belongsToShow(season: SyncedMediaRow, show: SyncedMediaRow): boolean {
  return season.parentRatingKey !== null && season.parentRatingKey === show.ratingKey;
}

/**
 * A whole season landing is one piece of news, not twenty. Episodes under a season this
 * run also added fold into it as a count, and a show whose seasons are already announcing
 * drops out, since those messages name it anyway.
 */
export function collapseMediaChanges(collected: readonly CollectedChange[]): {
  announced: AnnouncedChange[];
  absorbed: number;
} {
  const added = collected.filter((c) => c.change.kind === 'added');
  const seasons = added.filter((c) => c.change.row.mediaType === 'season');
  const episodes = added.filter((c) => c.change.row.mediaType === 'episode');

  const countBySeason = new Map<string, number>();
  const absorbed = new Set<CollectedChange>();
  for (const season of seasons) {
    let count = 0;
    for (const episode of episodes) {
      if (!belongsToSeason(episode.change.row, season.change.row)) continue;
      absorbed.add(episode);
      count += 1;
    }
    countBySeason.set(season.change.row.ratingKey, count);
  }

  for (const show of added) {
    if (show.change.row.mediaType !== 'show') continue;
    if (seasons.some((s) => belongsToShow(s.change.row, show.change.row))) absorbed.add(show);
  }

  const announced: AnnouncedChange[] = [];
  for (const entry of collected) {
    if (absorbed.has(entry)) continue;
    const count =
      entry.change.kind === 'added' && entry.change.row.mediaType === 'season'
        ? countBySeason.get(entry.change.row.ratingKey)
        : undefined;
    announced.push(
      count === undefined ? { collected: entry } : { collected: entry, addedEpisodeCount: count }
    );
  }

  return { announced, absorbed: absorbed.size };
}

function subjectOf(entry: CollectedChange, addedEpisodeCount: number | undefined): MediaSubject {
  const { row } = entry.change;
  return {
    libraryItemId: row.id,
    ratingKey: row.ratingKey,
    mediaId: row.mediaId,
    title: row.title,
    grandparentTitle: row.grandparentTitle,
    parentTitle: row.parentTitle,
    grandparentRatingKey: row.grandparentRatingKey,
    parentRatingKey: row.parentRatingKey,
    parentIndex: row.parentIndex,
    itemIndex: row.itemIndex,
    type: row.mediaType,
    year: row.year,
    imdbId: row.imdbId,
    tmdbId: row.tmdbId,
    tvdbId: row.tvdbId,
    thumbPath: row.thumbPath,
    libraryId: entry.libraryId,
    libraryName: entry.libraryName,
    quality: row.quality,
    ...(addedEpisodeCount !== undefined && { addedEpisodeCount }),
  };
}

/** Collapses everything the run collected and dispatches what survives the cap. */
export async function flushMediaAnnounceRun(run: MediaAnnounceRun): Promise<void> {
  if (run.collected.length === 0) return;
  const { announced } = collapseMediaChanges(run.collected);
  run.collected = [];

  const sending = announced.slice(0, run.budget.remaining);
  run.budget.remaining -= sending.length;
  run.budget.suppressed += announced.length - sending.length;

  for (const { collected: entry, addedEpisodeCount } of sending) {
    const media = subjectOf(entry, addedEpisodeCount);
    if (entry.change.kind === 'added') {
      await dispatchMediaAdded({ server: run.server, media });
    } else {
      await dispatchMediaUpgraded({
        server: run.server,
        media,
        from: entry.change.from,
        changed: entry.change.changed,
      });
    }
  }
}
