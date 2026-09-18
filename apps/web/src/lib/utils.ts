import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';
import { getName as getCountryNameFromCode } from 'country-list';
import { formatEpisodeLabel, type MediaType } from '@tracearr/shared';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Convert ISO 3166-1 alpha-2 country code to full country name.
 * Returns the original value if not a recognized code (e.g., "Local Network").
 */
export function getCountryName(code: string | null | undefined): string | null {
  if (!code) return null;
  const name = getCountryNameFromCode(code) ?? code;
  // Strip ISO 3166-1 article suffixes like "(the)", "(The)"
  return name.replace(/\s*\([Tt]he\)$/, '');
}

/**
 * Compact location string: "City, Region" → "City, Country" → Country → null.
 * Suitable for table cells, card footers, and other space-constrained displays.
 */
export function formatLocationCompact(
  city: string | null | undefined,
  region: string | null | undefined,
  country: string | null | undefined
): string | null {
  const countryName = getCountryName(country);
  if (city && region) return `${city}, ${region}`;
  if (city && countryName) return `${city}, ${countryName}`;
  return city ?? countryName ?? null;
}

/**
 * Media display fields interface for formatting media titles
 */
interface MediaDisplayFields {
  mediaType: MediaType | null;
  mediaTitle: string | null;
  grandparentTitle?: string | null;
  seasonNumber?: number | null;
  episodeNumber?: number | null;
  year?: number | null;
  channelTitle?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  serverType?: string | null;
}

/**
 * Playback position as a percentage of the length. Null when either is
 * unknown: an import can carry a length with no position, and that is not 0%.
 */
export function getSessionProgress(session: {
  progressMs: number | null;
  totalDurationMs: number | null;
}): number | null {
  if (!session.totalDurationMs || session.progressMs == null) return null;
  return Math.min(100, Math.round((session.progressMs / session.totalDurationMs) * 100));
}

/**
 * Get display title for media (handles TV shows vs movies vs music)
 * Formats media information consistently across the application.
 *
 * @param media - Media object with display fields
 * @returns Object with title and subtitle for display
 */
export function getMediaDisplay(media: MediaDisplayFields): {
  title: string;
  subtitle: string | null;
} {
  const unifiedLiveTv = ['jellyfin', 'emby', 'dispatcharr'].includes(media.serverType ?? '');
  if (media.mediaType === 'live' && unifiedLiveTv) {
    const channelTitle = media.channelTitle?.trim() || (media.mediaTitle ?? '');
    const programmeTitle = media.mediaTitle?.trim() || null;
    return {
      title: channelTitle,
      subtitle: programmeTitle && programmeTitle !== channelTitle ? programmeTitle : null,
    };
  }
  if (media.mediaType === 'live') return { title: media.mediaTitle ?? '', subtitle: null };

  if (media.mediaType === 'episode' && media.grandparentTitle) {
    // TV Show episode
    const episodeInfo =
      formatEpisodeLabel(media.seasonNumber, media.episodeNumber, {
        spaced: true,
      }) ?? '';
    return {
      title: media.grandparentTitle,
      subtitle: episodeInfo
        ? `${episodeInfo} · ${media.mediaTitle ?? ''}`
        : (media.mediaTitle ?? null),
    };
  }
  if (media.mediaType === 'track') {
    // Music track - show track name as title, artist/album as subtitle
    const parts: string[] = [];
    if (media.artistName) parts.push(media.artistName);
    if (media.albumName) parts.push(media.albumName);
    return {
      title: media.mediaTitle ?? '',
      subtitle: parts.length > 0 ? parts.join(' · ') : null,
    };
  }
  // Movie or other
  return {
    title: media.mediaTitle ?? '',
    subtitle: media.year ? `${media.year}` : null,
  };
}

/** crypto.randomUUID needs a secure context; a LAN address over plain http only has getRandomValues. */
export function randomUuid(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // version 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
