import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  formatMediaTech,
  resolutionTierRank,
  POSTER_IMAGE_SIZE,
  type WatchedState,
} from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { WatchedBadge, watchedLabelKey } from './WatchedBadge';
import { ServerDots } from './ServerDots';
import { dedupeServersById } from './dedupeServersById';
import { HoverOverlay, type HoverOverlayServer } from './HoverOverlay';

/** One URL per poster: the server keeps one cached copy at 360x540. The grid alone asks for the LQIP race. */
export function buildPosterSrc(
  posterUrl: string,
  posterVersion: string | null,
  options: { lqip?: boolean } = {}
): string {
  const url = new URL(posterUrl, window.location.origin);
  url.searchParams.set('width', String(POSTER_IMAGE_SIZE.width));
  url.searchParams.set('height', String(POSTER_IMAGE_SIZE.height));
  if (posterVersion) url.searchParams.set('v', posterVersion);
  else url.searchParams.delete('v');
  if (options.lqip) url.searchParams.set('lqip', '1');
  else url.searchParams.delete('lqip');
  return `${url.pathname}${url.search}`;
}

/**
 * Two-letter glyph for the no-poster fallback. Prefers the initial of the
 * first two words (skips nothing - even "The Bear" reads as "TB", matching
 * how the mockup abbreviates multi-word titles) and falls back to the first
 * two characters of a single-word title.
 */
function posterInitials(title: string): string {
  const words = title.trim().split(/\s+/).filter(Boolean);
  const [first, second] = words;
  if (!first) return '';
  if (!second) return (first[0] ?? '').toUpperCase() + (first[1] ?? '').toLowerCase();
  return (first[0] ?? '').toUpperCase() + (second[0] ?? '').toUpperCase();
}

/** Darkens a `#rrggbb` hex color for the fallback gradient's bottom stop. */
function darkenHex(hex: string, amount = 0.55): string {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) return hex;
  const num = parseInt(match[1], 16);
  const channel = (shift: number) =>
    Math.round(((num >> shift) & 0xff) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(16)}${channel(8)}${channel(0)}`;
}

/**
 * Fallback poster background: a gradient from the title's dominant color to
 * a darkened variant, or a neutral muted gradient when no dominant color was
 * ever extracted (e.g. the source never had a poster to sample).
 */
function fallbackGradient(dominantColor: string | null): string {
  if (!dominantColor) {
    return 'linear-gradient(160deg, hsl(var(--muted)) 0%, hsl(var(--card-raised)) 100%)';
  }
  return `linear-gradient(160deg, ${dominantColor} 0%, ${darkenHex(dominantColor)} 100%)`;
}

export interface PosterCardServer extends HoverOverlayServer {
  videoResolution?: string | null;
  /** Active physical files of this copy; drives the versions chip */
  versionCount?: number;
}

/**
 * Distinct known resolutions across every copy (library_items row), best
 * quality first. Copies with no resolution recorded don't count as a
 * distinct value - only known values differentiate "same" from "differ".
 */
function distinctResolutions(servers: { videoResolution?: string | null }[]): string[] {
  const known = new Set<string>();
  for (const server of servers) {
    if (server.videoResolution) known.add(server.videoResolution);
  }
  return [...known].sort((a, b) => (resolutionTierRank(b) ?? 0) - (resolutionTierRank(a) ?? 0));
}

interface PosterCardProps {
  mediaId: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  posterVersion: string | null;
  dominantColor: string | null;
  servers: PosterCardServer[];
  resolutionBest: string | null;
  watchedState: WatchedState;
  /** Requester-grain overlay; undefined on shelf cards (all-users aggregate). */
  watchedStateSelf?: WatchedState;
  plays?: number;
  viewers?: number;
  /** Corner chip on Most Watched shelves; mutually exclusive with newEpisodes. */
  rank?: number;
  /** Corner chip on Recently Added shelves for grouped shows; mutually exclusive with rank. */
  newEpisodes?: number;
  loading?: 'eager' | 'lazy';
  fetchPriority?: 'high' | 'low' | 'auto';
  className?: string;
}

/**
 * The single interactive surface of the card: one <a> (single tab stop),
 * accessible name = "title (year)" plus ", rank N" on ranked shelves, plus
 * the new-episode count on grouped shows, plus the watched state whenever
 * it isn't 'unwatched' - all three duplicate what their corner chip or
 * badge shows visually, since the aria-label overrides the whole subtree
 * and none of that markup would otherwise reach screen readers navigating
 * by link.
 */
export function PosterCard({
  mediaId,
  title,
  year,
  posterUrl,
  posterVersion,
  dominantColor,
  servers,
  resolutionBest,
  watchedState,
  watchedStateSelf,
  plays,
  viewers,
  rank,
  newEpisodes,
  loading = 'lazy',
  fetchPriority,
  className,
}: PosterCardProps) {
  const { t } = useTranslation('pages');
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    setImgError(false);
  }, [posterUrl]);

  const showFallback = !posterUrl || imgError;
  const showRank = rank != null;
  const hasNewEpisodes = newEpisodes != null && newEpisodes > 0;
  const showNewEpisodesChip = !showRank && hasNewEpisodes;
  const rankSuffix = rank != null ? t('media.posterCard.rankSuffix', { rank }) : '';
  const newEpisodesSuffix = hasNewEpisodes
    ? `, ${t('media.landing.card.newEpisodes', { count: newEpisodes })}`
    : '';
  const watchedSuffix =
    watchedState === 'watched'
      ? `, ${t(watchedLabelKey(watchedStateSelf))}`
      : watchedState === 'partial'
        ? `, ${t('media.posterCard.watchedState.partial')}`
        : '';

  // Physical files across every copy: multi-version rows count each file, so
  // the chip survives same-server duplicates being collapsed into one item
  const fileCount = servers.reduce((sum, server) => sum + (server.versionCount || 1), 0);
  const versionsResolutions = distinctResolutions(servers);
  // Only shown when it says something the server dots can't: more files than
  // servers, or a resolution split worth a glance-level callout.
  const showVersionsChip =
    fileCount > dedupeServersById(servers).length || versionsResolutions.length === 2;
  const versionsChipLabel =
    versionsResolutions.length === 2
      ? versionsResolutions.map(formatMediaTech).join(' · ')
      : t('media.posterCard.versionsChip', { count: fileCount });
  const versionsSuffix = showVersionsChip
    ? `, ${t('media.posterCard.versions', { count: fileCount })}`
    : '';

  const accessibleName =
    (year != null ? `${title} (${year})` : title) +
    rankSuffix +
    newEpisodesSuffix +
    watchedSuffix +
    versionsSuffix;

  return (
    <div className={cn('group relative', showRank && 'pl-9', className)}>
      {showRank && (
        // Lives in the pl-9 lane the wrapper reserves, on the page background.
        // Ghost ring built from 8 offset text-shadows: a stroke would trace the
        // glyph's self-intersecting outline and double-draw digits with
        // enclosed counters (0/4/6/8/9); shadow copies dilate cleanly.
        <span
          aria-hidden="true"
          style={{
            textShadow: [
              '1.25px 0 0 hsl(var(--foreground) / 0.45)',
              '-1.25px 0 0 hsl(var(--foreground) / 0.45)',
              '0 1.25px 0 hsl(var(--foreground) / 0.45)',
              '0 -1.25px 0 hsl(var(--foreground) / 0.45)',
              '0.9px 0.9px 0 hsl(var(--foreground) / 0.45)',
              '-0.9px 0.9px 0 hsl(var(--foreground) / 0.45)',
              '0.9px -0.9px 0 hsl(var(--foreground) / 0.45)',
              '-0.9px -0.9px 0 hsl(var(--foreground) / 0.45)',
            ].join(', '),
          }}
          className="pointer-events-none absolute top-0 left-0 z-10 flex w-9 justify-end pr-1 text-[26px] leading-none font-extrabold tracking-[-0.01em] text-transparent tabular-nums transition-transform duration-200 group-hover:-translate-y-[3px]"
        >
          {rank}
        </span>
      )}
      <Link
        to={`/media/${mediaId}`}
        aria-label={accessibleName}
        className="focus-visible:ring-ring block rounded-md focus-visible:ring-2 focus-visible:outline-none"
      >
        <div
          className="bg-muted relative aspect-[2/3] overflow-hidden rounded-[calc(var(--radius)+2px)] transition-transform duration-200 group-hover:-translate-y-[3px] group-hover:shadow-[0_12px_32px_hsl(240_10%_2%/0.7)]"
          style={dominantColor ? { backgroundColor: dominantColor } : undefined}
        >
          {showFallback ? (
            <div
              className="flex h-full w-full flex-col items-center justify-center gap-0.5 p-2 text-center"
              style={{ background: fallbackGradient(dominantColor) }}
            >
              <span
                aria-hidden="true"
                className="text-foreground/85 text-[34px] leading-none font-bold tracking-[-0.02em] [text-shadow:0_2px_12px_hsl(240_10%_2%/0.4)]"
              >
                {posterInitials(title)}
              </span>
              <small className="text-foreground/75 line-clamp-2 text-[9px] font-semibold tracking-[0.14em] uppercase">
                {title}
              </small>
            </div>
          ) : (
            <img
              src={buildPosterSrc(posterUrl, posterVersion, { lqip: true })}
              alt=""
              loading={loading}
              decoding="async"
              fetchPriority={fetchPriority}
              onError={() => setImgError(true)}
              className="h-full w-full object-cover"
            />
          )}
          {(showNewEpisodesChip || showVersionsChip) && (
            <div className="absolute top-1.5 left-1.5 flex flex-col items-start gap-1">
              {showNewEpisodesChip && (
                <span
                  aria-hidden="true"
                  className="text-foreground rounded-full border border-white/12 bg-[hsl(240_10%_4%/0.75)] px-2 py-0.5 text-[10.5px] font-semibold backdrop-blur-sm"
                >
                  {t('media.landing.card.newEpisodesChip', { count: newEpisodes })}
                </span>
              )}
              {showVersionsChip && (
                <span
                  aria-hidden="true"
                  className="text-foreground rounded-full border border-white/12 bg-[hsl(240_10%_4%/0.75)] px-2 py-0.5 text-[10.5px] font-semibold backdrop-blur-sm"
                >
                  {versionsChipLabel}
                </span>
              )}
            </div>
          )}
          <div className="absolute top-1.5 right-1.5">
            <WatchedBadge watchedState={watchedState} watchedStateSelf={watchedStateSelf} />
          </div>
          <div className="absolute right-1.5 bottom-1.5">
            <ServerDots
              servers={servers}
              className="rounded-full border border-white/12 bg-[hsl(240_10%_4%/0.75)] px-1.5 py-1 backdrop-blur-sm"
            />
          </div>
          <HoverOverlay
            title={title}
            year={year}
            servers={servers}
            resolution={resolutionBest}
            plays={plays}
            viewers={viewers}
          />
        </div>
        {/* Fixed two-line block - h-10 keeps every card the same height so the
            virtualized grid's row math stays exact. Year lives in the hover. */}
        <div className="mt-1.5">
          <span className="line-clamp-2 h-10 text-sm leading-5 font-medium">{title}</span>
        </div>
      </Link>
    </div>
  );
}
