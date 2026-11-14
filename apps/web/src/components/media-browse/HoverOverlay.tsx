import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { safeFormatDate } from '@/lib/dateFormat';
import type { ServerDotEntry } from './ServerDots';
import { dedupeServersById } from './dedupeServersById';

export interface HoverOverlayServer extends ServerDotEntry {
  addedAt: string;
}

// The overlay box is the poster's fixed aspect box - a 3-line title plus an
// uncapped server list can push the bottom stats past it, where overflow-hidden
// silently clips them. Two rows + a "+N more" line always fit.
const MAX_SERVER_ROWS = 2;

interface HoverOverlayProps {
  title: string;
  year: number | null;
  /** Artists have no year; their album count takes its place. */
  albumCountLabel?: string | null;
  servers: HoverOverlayServer[];
  resolution: string | null;
  plays?: number;
  viewers?: number;
  className?: string;
}

/**
 * Positioned child of the poster div (the `overflow-hidden aspect-[2/3]`
 * box), never a child of the Link inside it: buttons or links here would be
 * invalid nesting and a screen-reader trap (spec amendment). `inset-0`
 * against that ancestor guarantees pixel-perfect poster coverage and
 * inherits its rounding/clipping for free, rather than trying to
 * re-measure the poster region from a sibling position. Revealed by the
 * wrapper's `group-hover`/`group-focus-within` state only - no JS
 * visibility toggling, no interactive children, since the card's own Link
 * already goes to the detail page and this stays a passive preview.
 */
export function HoverOverlay({
  title,
  year,
  albumCountLabel,
  servers,
  resolution,
  plays,
  viewers,
  className,
}: HoverOverlayProps) {
  const { t } = useTranslation(['pages', 'common']);

  const metaLine = [year != null ? String(year) : albumCountLabel, resolution]
    .filter((part): part is string => part != null)
    .join(' · ');

  const statsLine = [
    plays !== undefined ? t('common:count.play', { count: plays }) : null,
    viewers !== undefined ? t('media.posterCard.viewers', { count: viewers }) : null,
  ]
    .filter((part): part is string => part != null)
    .join(' · ');

  const dedupedServers = dedupeServersById(sortByAddedAtAscending(servers));

  return (
    <div
      aria-hidden="true"
      className={cn(
        'bg-overlay/55 text-overlay-foreground pointer-events-none absolute inset-0 flex flex-col overflow-hidden rounded-xl p-2.5 opacity-0 transition-opacity duration-150 group-focus-within:opacity-100 group-focus-within:backdrop-blur-md group-hover:opacity-100 group-hover:backdrop-blur-md',
        className
      )}
    >
      <h3 className="text-dense line-clamp-3 leading-snug font-semibold">{title}</h3>
      {metaLine && <p className="text-overlay-foreground/70 mt-1 truncate text-xs">{metaLine}</p>}
      <div className="mt-auto flex flex-col gap-1">
        {dedupedServers.slice(0, MAX_SERVER_ROWS).map((server) => (
          <span key={server.serverId} className="flex items-center gap-1.5 truncate text-xs">
            <span
              aria-hidden="true"
              className="bg-muted-foreground h-1.5 w-1.5 shrink-0 rounded-full"
              style={server.color ? { backgroundColor: server.color } : undefined}
            />
            <span className="text-overlay-foreground/80 truncate">
              {t('media.posterCard.addedLabel', {
                date: safeFormatDate(server.addedAt, { month: 'short', year: 'numeric' }),
              })}
            </span>
          </span>
        ))}
        {dedupedServers.length > MAX_SERVER_ROWS && (
          <span className="text-overlay-foreground/60 truncate text-xs">
            {t('media.posterCard.moreServers', { count: dedupedServers.length - MAX_SERVER_ROWS })}
          </span>
        )}
        {statsLine && (
          <p className="text-overlay-foreground/90 truncate text-xs font-medium">{statsLine}</p>
        )}
      </div>
    </div>
  );
}

/**
 * A title can have two library_items on the same server (e.g. a film and its
 * trailer), and the hover panel only has room for one "Added" row per server.
 * Sorting ascending first means the shared keep-first dedupe below keeps the
 * earliest addedAt for each server, since that's the more useful "Added"
 * date when it's shown.
 */
function sortByAddedAtAscending(servers: HoverOverlayServer[]): HoverOverlayServer[] {
  return [...servers].sort((a, b) => new Date(a.addedAt).getTime() - new Date(b.addedAt).getTime());
}
