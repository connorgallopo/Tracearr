/**
 * Shared naming for the two media events. A season names its show, an episode names
 * the show and where in it the episode sits, and everything else names itself.
 */

import { BYTES_PER_GB, formatEpisodeLabel, normalizeResolutionLabel } from '@tracearr/shared';
import type { MediaQuality } from '../../automations/types.js';
import type { MediaEventPayload, MediaUpgradedPayload } from '../events.js';

/**
 * A season's own title is the season label on Plex ("Season 3") but often a real name on
 * Jellyfin and Emby ("All Systems Red"), so the number comes from the index and the title
 * only survives when it adds something.
 */
const GENERIC_SEASON_TITLE = /^season\s*\d+$/i;

export function seasonLabel(ctx: MediaEventPayload): string {
  const numbered = ctx.parentIndex === null ? null : `Season ${String(ctx.parentIndex)}`;
  const named = seasonName(ctx);
  if (numbered === null) return named ?? ctx.title.trim();
  return named === null ? numbered : `${numbered}: ${named}`;
}

/** A season's title, or null when it is only the generic label the index already carries. */
function seasonName(ctx: MediaEventPayload): string | null {
  const named = ctx.title.trim();
  if (named === '' || GENERIC_SEASON_TITLE.test(named)) return null;
  return named;
}

/** The show, artist, or album this item sits under; null when the item is the top level. */
export function parentName(ctx: MediaEventPayload): string | null {
  return ctx.mediaType === 'season' ? ctx.parentTitle : ctx.grandparentTitle;
}

/** A show and an episode code, as the notification headline prints them. */
export function episodeHeadline(
  show: string,
  title: string,
  season: number | null,
  episode: number | null
): string {
  const code = formatEpisodeLabel(season, episode, { separator: ' · ' });
  return code === null ? `${show} — ${title}` : `${show} — ${code}`;
}

/** The headline: what a person would call this item out loud. */
export function mediaHeadline(ctx: MediaEventPayload): string {
  const parent = parentName(ctx);
  if (ctx.mediaType === 'season') {
    return parent === null ? seasonLabel(ctx) : `${parent} — ${seasonLabel(ctx)}`;
  }
  if (ctx.mediaType === 'episode') {
    return episodeHeadline(parent ?? ctx.title, ctx.title, ctx.parentIndex, ctx.itemIndex);
  }
  return parent === null ? ctx.title : `${parent} — ${ctx.title}`;
}

export function mediaHeadlineWithYear(ctx: MediaEventPayload): string {
  const headline = mediaHeadline(ctx);
  return ctx.year === null ? headline : `${headline} (${String(ctx.year)})`;
}

/** The item's own title, when the headline named a parent instead of it. */
export function mediaSubtitle(ctx: MediaEventPayload): string | null {
  if (ctx.mediaType === 'episode') return ctx.title;
  if (ctx.mediaType === 'season') return seasonName(ctx);
  return null;
}

function episodeCount(count: number): string {
  return `${String(count)} ${count === 1 ? 'episode' : 'episodes'}`;
}

/** One line for the destinations that get a title and a body and nothing else. */
export function formatMediaAddedMessage(ctx: MediaEventPayload): string {
  const where = `${ctx.libraryName} on ${ctx.serverName}`;
  // A season folder can appear before any of its episodes, and "0 episodes added" is a lie.
  if (ctx.addedEpisodeCount !== undefined && ctx.addedEpisodeCount > 0) {
    return `${mediaHeadlineWithYear(ctx)} — ${episodeCount(ctx.addedEpisodeCount)} added to ${where}`;
  }
  const subtitle = ctx.mediaType === 'episode' ? ` "${ctx.title}"` : '';
  return `${mediaHeadlineWithYear(ctx)}${subtitle} was added to ${where}`;
}

/**
 * Values as a message shows them: bytes in GB, a resolution in its display spelling.
 * A null renders empty, since it reaches this only as a `{{media.to.*}}` substitution -
 * a field counts as moved only when both sides hold a value.
 */
export function qualityText(field: keyof MediaQuality, value: string | number | null): string {
  if (value === null) return '';
  if (field === 'fileSize') return `${(Number(value) / BYTES_PER_GB).toFixed(1)} GB`;
  if (field === 'resolution') return normalizeResolutionLabel(String(value)) ?? String(value);
  if (field === 'audioChannels') return `${String(value)}ch`;
  return String(value);
}

/** Field names as a message spells them, rather than the camelCase the column uses. */
export const QUALITY_FIELD_LABELS: Record<keyof MediaQuality, string> = {
  resolution: 'Resolution',
  dynamicRange: 'Dynamic range',
  videoCodec: 'Video codec',
  audioCodec: 'Audio codec',
  audioChannels: 'Audio channels',
  fileSize: 'Size',
};

/** Every field that moved, resolution first when it is among them. */
export function qualityMoves(ctx: MediaUpgradedPayload): { label: string; move: string }[] {
  const ordered = ctx.changed.toSorted((a, b) =>
    a === 'resolution' ? -1 : b === 'resolution' ? 1 : 0
  );
  return ordered.map((field) => ({
    label: QUALITY_FIELD_LABELS[field],
    move: `${qualityText(field, ctx.from[field])} → ${qualityText(field, ctx.to[field])}`,
  }));
}

/** One line for the destinations that get a title and a body and nothing else. */
export function formatMediaUpgradedMessage(ctx: MediaUpgradedPayload): string {
  const moves = qualityMoves(ctx);
  const detail =
    moves.length === 0
      ? ''
      : `: ${moves.map((m) => `${m.label.toLowerCase()} ${m.move}`).join(', ')}`;
  return `${mediaHeadlineWithYear(ctx)} on ${ctx.serverName} was upgraded${detail}`;
}
