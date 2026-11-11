/**
 * Media display formatting shared across web, mobile, and server notifications.
 */

import { SERVER_PROFILES } from './serverProfiles.js';

export interface FormatEpisodeLabelOptions {
  /** When provided, the label is only produced if this equals 'episode'. */
  mediaType?: string | null;
  /** Use "S01 E02" instead of the default "S01E02". */
  spaced?: boolean;
  /** Sits between the halves, e.g. " · " for "S01 · E02". Wins over `spaced`. */
  separator?: string;
}

/**
 * Format a season/episode pair into a zero-padded label (e.g. "S00E01").
 * Season 0 and episode 0 are valid (Specials) and must render, not be hidden -
 * only a genuinely missing (null/undefined) season or episode suppresses the label.
 */
export function formatEpisodeLabel(
  seasonNumber: number | null | undefined,
  episodeNumber: number | null | undefined,
  options: FormatEpisodeLabelOptions = {}
): string | null {
  if (options.mediaType !== undefined && options.mediaType !== 'episode') return null;
  if (seasonNumber == null || episodeNumber == null) return null;

  const season = String(seasonNumber).padStart(2, '0');
  const episode = String(episodeNumber).padStart(2, '0');
  const gap = options.separator ?? (options.spaced ? ' ' : '');
  return `S${season}${gap}E${episode}`;
}

/** Whether a play names a show: an episode, or a live program that is one */
export function namesShow(media: {
  mediaType: string | null;
  grandparentTitle?: string | null;
}): media is { mediaType: string; grandparentTitle: string } {
  return (media.mediaType === 'episode' || media.mediaType === 'live') && !!media.grandparentTitle;
}

/**
 * An avatar the browser may load straight from where it lives. plex.tv serves Plex account
 * avatars; any other absolute address would let whoever set it see who opens the page, so those
 * are never loaded and media server avatars go through the image proxy instead.
 */
export function isDirectAvatarUrl(url: string): boolean {
  return /^https:\/\/([a-z0-9-]+\.)*plex\.tv\//i.test(url);
}

/** An absolute avatar address on a host some server type's art is served from, so the image proxy may fetch it */
export function isProxiableAvatarUrl(url: string): boolean {
  if (!URL.canParse(url)) return false;
  const { hostname } = new URL(url);
  return Object.values(SERVER_PROFILES).some((profile) =>
    profile.guideImageHosts.includes(hostname)
  );
}
