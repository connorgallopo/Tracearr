import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import type { WatchedState } from '@tracearr/shared';
import { cn } from '@/lib/utils';

interface WatchedBadgeProps {
  /** Anyone-grain: has any user watched this. */
  watchedState: WatchedState;
  /** Requester-grain: has the signed-in admin personally watched this.
   * Omitted on shelf cards (all-users aggregate, no per-viewer state), which
   * falls back to the single-tone "someone watched this" rendering below. */
  watchedStateSelf?: WatchedState;
  className?: string;
}

/** Whether the fully-watched badge/label should read as "by you" - self wins
 * whenever both the requester and someone else have watched it. Shared by
 * WatchedBadge (the icon) and PosterCard (the card's aria-label suffix) so
 * the two never drift on which grain wins. */
export function watchedByRequester(watchedStateSelf: WatchedState | undefined): boolean {
  return watchedStateSelf === 'watched';
}

/**
 * A background conic-gradient is not clipped to the border radius by Firefox
 * once an ancestor is transformed (the hovered poster card), so the pie is an
 * SVG arc instead. The slice is a fixed 62%: a glyph for "partly watched",
 * not a progress meter.
 */
const PARTIAL_FRACTION = 0.62;
const PARTIAL_ARC = (() => {
  const angle = PARTIAL_FRACTION * 2 * Math.PI;
  const x = (1 + Math.sin(angle)).toFixed(3);
  const y = (1 - Math.cos(angle)).toFixed(3);
  return `M1 1 L1 0 A1 1 0 ${PARTIAL_FRACTION > 0.5 ? 1 : 0} 1 ${x} ${y} Z`;
})();

type WatchedLabelKey =
  | 'media.posterCard.watchedState.watched'
  | 'media.posterCard.watchedState.watchedByYou'
  | 'media.posterCard.watchedState.watchedByOthers';

/** i18n key for the fully-watched state's accessible name, given both grains. */
export function watchedLabelKey(watchedStateSelf: WatchedState | undefined): WatchedLabelKey {
  if (watchedStateSelf === undefined) return 'media.posterCard.watchedState.watched';
  return watchedByRequester(watchedStateSelf)
    ? 'media.posterCard.watchedState.watchedByYou'
    : 'media.posterCard.watchedState.watchedByOthers';
}

/**
 * One of the card's two quiet indicators (spec: "at most two quiet
 * indicators"). Always visible, since watched state at a glance matters for
 * this monitoring product: a solid check for fully watched, a distinct
 * half-filled ring for partially watched, and nothing for unwatched (the
 * shelf/context already conveys that, and badging every untouched card
 * would be noise).
 *
 * Both indicators are two-tone on the same rule: success/green only when
 * the requester's own watch state earned it, warning/orange when the state
 * comes from someone else (or the self grain is unavailable, as on shelf
 * cards - green must never claim "you watched" without requester data).
 * Green wins whenever both are true. Teal was tried for the self tone and
 * reads as green at 18px, which hid the split entirely.
 */
export function WatchedBadge({ watchedState, watchedStateSelf, className }: WatchedBadgeProps) {
  const { t } = useTranslation('pages');

  if (watchedState === 'watched') {
    const bySelf = watchedByRequester(watchedStateSelf);
    return (
      <span
        className={cn(
          'text-background border-background/55 inline-flex size-[18px] items-center justify-center rounded-full border-2',
          bySelf ? 'bg-success' : 'bg-warning',
          className
        )}
      >
        <Check aria-hidden="true" className="h-3 w-3" strokeWidth={3} />
        <span className="sr-only">{t(watchedLabelKey(watchedStateSelf))}</span>
      </span>
    );
  }

  if (watchedState === 'partial') {
    const selfProgress = watchedStateSelf === 'partial' || watchedStateSelf === 'watched';
    const tone = selfProgress ? '--success' : '--warning';
    return (
      <span
        className={cn(
          'border-background/55 inline-flex size-[18px] overflow-hidden rounded-full border-2',
          className
        )}
      >
        <svg viewBox="0 0 2 2" className="size-full" aria-hidden="true">
          <circle cx="1" cy="1" r="1" fill="hsl(var(--muted-foreground) / 0.6)" />
          <path d={PARTIAL_ARC} fill={`hsl(var(${tone}))`} />
        </svg>
        <span className="sr-only">{t('media.posterCard.watchedState.partial')}</span>
      </span>
    );
  }

  return null;
}
