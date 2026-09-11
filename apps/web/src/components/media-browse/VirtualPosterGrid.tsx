import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { CatalogRow, CatalogRowServerEntry, ServerType } from '@tracearr/shared';
import { PosterCard, type PosterCardServer } from './PosterCard';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** 138px min card + 14px gap - the ResizeObserver-driven column math from the plan. */
export const MIN_CARD_WIDTH = 138;
export const GRID_GAP = 14;
export const COLUMN_STEP = MIN_CARD_WIDTH + GRID_GAP;
export const ROW_FOOTER_HEIGHT = 72;
/** The row wrapper's own `pb-4` (outside PosterCard) - omitting it understates
 * every row's real height, which compounds into a large scrollToIndex offset
 * error over hundreds of unmeasured rows on a deep jump. */
export const ROW_BOTTOM_PADDING = 16;

/** Below this the page scrolls instead of the grid shrinking further. */
export const MIN_GRID_HEIGHT = 480;

/** Viewport height left below the grid's top edge, minus the page's bottom padding, never under MIN_GRID_HEIGHT. */
export function computeGridHeight(
  viewportHeight: number,
  gridTop: number,
  bottomPadding: number
): number {
  return Math.max(MIN_GRID_HEIGHT, Math.floor(viewportHeight - gridTop - bottomPadding));
}

/** How long the container must sit still before its offset rides history.replaceState. */
export const SCROLL_IDLE_MS = 200;

/** Landing-drift tolerance and retry budget for a scrollToItem jump's settle loop. */
export const JUMP_SETTLE_TOLERANCE_PX = 2;
export const JUMP_STABLE_FRAMES_REQUIRED = 2;
export const JUMP_MAX_CORRECTIONS = 5;
export const JUMP_MAX_DURATION_MS = 1500;

export function computeColumnCount(width: number): number {
  return Math.max(2, Math.floor(width / COLUMN_STEP));
}

export function computeCardWidth(width: number, columnCount: number): number {
  if (columnCount <= 0) return MIN_CARD_WIDTH;
  const totalGap = GRID_GAP * (columnCount - 1);
  return Math.max(MIN_CARD_WIDTH, (width - totalGap) / columnCount);
}

/** cardWidth * 1.5 (aspect-[2/3] poster) + the fixed two-line title footer + the row wrapper's own bottom padding. */
export function computeRowHeight(cardWidth: number): number {
  return cardWidth * 1.5 + ROW_FOOTER_HEIGHT + ROW_BOTTOM_PADDING;
}

/** Fixed grid-row count for a known item total - no loader rows; unloaded
 * cells render as skeletons in place. */
export function computeRowCount(totalItems: number, columnCount: number): number {
  if (columnCount <= 0 || totalItems <= 0) return 0;
  return Math.ceil(totalItems / columnCount);
}

export interface ViewportInfo {
  /** First item index any rendered (incl. overscan) row needs. */
  renderFirstItem: number;
  /** Last item index any rendered (incl. overscan) row needs. */
  renderLastItem: number;
  /** First item index of the row actually at the top of the viewport. */
  topItem: number;
  /** Columns in the top row - needed to tell which letter a mixed row belongs to. */
  columnCount: number;
}

/** Maps the virtualizer's rendered row span + visible start row to item
 * indices. Pure so the viewport contract is testable without a real
 * virtualizer (jsdom cannot lay out a scroll container). */
export function computeViewportInfo(
  renderFirstRow: number | undefined,
  renderLastRow: number | undefined,
  visibleStartRow: number | undefined,
  columnCount: number,
  totalItems: number
): ViewportInfo | null {
  if (
    renderFirstRow === undefined ||
    renderLastRow === undefined ||
    visibleStartRow === undefined ||
    columnCount <= 0 ||
    totalItems <= 0
  ) {
    return null;
  }
  const lastItem = Math.min((renderLastRow + 1) * columnCount - 1, totalItems - 1);
  return {
    renderFirstItem: renderFirstRow * columnCount,
    renderLastItem: lastItem,
    topItem: Math.min(visibleStartRow * columnCount, totalItems - 1),
    columnCount,
  };
}

interface ServerLookupEntry {
  name: string;
  type: ServerType;
  color?: string | null;
}

function toPosterCardServers(
  entries: CatalogRowServerEntry[],
  serverById: Map<string, ServerLookupEntry>
): PosterCardServer[] {
  return entries.map((entry) => {
    const server = serverById.get(entry.serverId);
    return {
      serverId: entry.serverId,
      name: server?.name ?? entry.serverId,
      type: server?.type ?? 'plex',
      color: server?.color ?? null,
      addedAt: entry.addedAt,
      videoResolution: entry.videoResolution,
      versionCount: entry.versionCount,
    };
  });
}

/** One poster cell. Memoized so a virtualizer range update (which re-renders
 * every mounted row) only re-renders cells whose row data actually changed -
 * the servers array conversion is also cached per row here for the same
 * reason. */
const GridCell = memo(function GridCell({
  row,
  serverById,
  eager,
}: {
  row: CatalogRow;
  serverById: Map<string, ServerLookupEntry>;
  eager: boolean;
}) {
  const servers = useMemo(() => toPosterCardServers(row.servers, serverById), [row, serverById]);
  return (
    <PosterCard
      mediaId={row.mediaId}
      title={row.title}
      year={row.year}
      posterUrl={row.posterUrl}
      posterVersion={row.posterVersion}
      dominantColor={row.dominantColor}
      servers={servers}
      resolutionBest={row.resolutionBest}
      watchedState={row.watchedState}
      watchedStateSelf={row.watchedStateSelf}
      plays={row.plays}
      viewers={row.viewers}
      loading={eager ? 'eager' : 'lazy'}
      fetchPriority={eager ? 'high' : undefined}
    />
  );
});

function SkeletonCell() {
  return (
    <div className="space-y-1.5">
      <Skeleton className="aspect-[2/3] w-full rounded-md" />
      <Skeleton className="h-3.5 w-full" />
    </div>
  );
}

export interface VirtualPosterGridHandle {
  /** Scrolls so the row containing itemIndex sits at the top of the viewport. */
  scrollToItem: (itemIndex: number) => void;
}

/** Bundles key + offset as one atomic value so they can never land on the grid a render apart. */
export interface ScrollRestoreTarget {
  key: string | number;
  /** Offset (px) to restore to for this key, or null to seek to the top. */
  offset: number | null;
}

/** Never equal to any real key, so this grid instance's first target is always unconsumed. */
const SCROLL_RESTORE_UNSET = Symbol('scroll-restore-unset');

interface VirtualPosterGridProps {
  totalItems: number;
  /** Sparse row accessor; undefined renders a skeleton cell in place. */
  getRow: (index: number) => CatalogRow | undefined;
  serverById: Map<string, ServerLookupEntry>;
  ariaLabel: string;
  /** rAF-throttled viewport report: which items the rendered rows need and
   * which item leads the visible top row. */
  onViewportChange?: (info: ViewportInfo) => void;
  /** The list + offset to seek to once rowCount > 0; a new key always triggers a fresh seek. */
  scrollRestore?: ScrollRestoreTarget;
  /** Fired right after a non-null offset has been applied, so the parent can clear it. */
  onScrollRestored?: () => void;
  /** Fired ~SCROLL_IDLE_MS after the container stops moving, carrying the current scrollTop. */
  onScrollIdle?: (offset: number) => void;
  /** Fired when real user input (wheel, touch, keyboard, pointer) cancels an in-flight jump. */
  onJumpCancelled?: () => void;
  /** Fired once a jump has landed stably (or exhausted its correction budget). */
  onJumpSettled?: () => void;
  className?: string;
}

/**
 * Fixed-total virtualized poster grid: the scroll space is sized from
 * totalItems up front, cells fill in as their pages arrive, and a letter
 * jump is nothing but scrollToItem on a precomputed offset. No loader rows,
 * no bidirectional paging, no prepend compensation - which page fetches is
 * entirely the parent's business, driven by onViewportChange.
 *
 * The container fills the window below its own top edge. That height comes
 * from the grid's document offset and the window, never from the
 * virtualizer's total-size div, so there is no height feedback loop.
 */
export const VirtualPosterGrid = forwardRef<VirtualPosterGridHandle, VirtualPosterGridProps>(
  function VirtualPosterGrid(
    {
      totalItems,
      getRow,
      serverById,
      ariaLabel,
      onViewportChange,
      scrollRestore,
      onScrollRestored,
      onScrollIdle,
      onJumpCancelled,
      onJumpSettled,
      className,
    },
    handleRef
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerWidth, setContainerWidth] = useState(0);
    const [containerHeight, setContainerHeight] = useState(MIN_GRID_HEIGHT);
    // The scrollRestore.key most recently seeked to; an unseen key always owes a fresh seek.
    const appliedScrollRestoreKeyRef = useRef<unknown>(SCROLL_RESTORE_UNSET);
    const idleTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
    const viewportRafRef = useRef<number | null>(null);
    // True once the mount effect has measured at least once (vs never measured).
    const hasMeasuredContainerRef = useRef(false);

    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) setContainerWidth(entry.contentRect.width);
        hasMeasuredContainerRef.current = true;
      });
      observer.observe(el);
      setContainerWidth(el.clientWidth);
      hasMeasuredContainerRef.current = true;
      return () => observer.disconnect();
    }, []);

    // The toolbar wrapping, a status banner or a window resize all move the
    // grid's top edge, and each of those resizes the body.
    useLayoutEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const page = el.closest('main');
      const fit = () => {
        const gridTop = el.getBoundingClientRect().top + window.scrollY;
        const bottomPadding = page ? parseFloat(getComputedStyle(page).paddingBottom) || 0 : 0;
        setContainerHeight(computeGridHeight(window.innerHeight, gridTop, bottomPadding));
      };
      fit();
      const observer = new ResizeObserver(fit);
      observer.observe(document.body);
      window.addEventListener('resize', fit);
      return () => {
        observer.disconnect();
        window.removeEventListener('resize', fit);
      };
    }, []);

    const columnCount = useMemo(() => computeColumnCount(containerWidth), [containerWidth]);
    const cardWidth = useMemo(
      () => computeCardWidth(containerWidth, columnCount),
      [containerWidth, columnCount]
    );
    // The real rendered height of the first mounted row, once known - every
    // row a deep jump has never rendered is still priced with estimateSize(),
    // so a merely-close theoretical estimate compounds into hundreds of
    // pixels of drift over hundreds of rows; the true measured height (rows
    // are visually uniform) makes that drift ~zero from the first jump on.
    const [measuredRowHeight, setMeasuredRowHeight] = useState<number | null>(null);
    const measuredForCardWidthRef = useRef<number | null>(null);
    const rowHeight = useMemo(
      () => measuredRowHeight ?? computeRowHeight(cardWidth),
      [measuredRowHeight, cardWidth]
    );
    const rowCount = useMemo(
      () => computeRowCount(totalItems, columnCount),
      [totalItems, columnCount]
    );

    const virtualizer = useVirtualizer({
      count: rowCount,
      getScrollElement: () => containerRef.current,
      estimateSize: () => rowHeight,
      overscan: 4,
      useFlushSync: false,
    });

    // estimateSize isn't a dependency of the virtualizer's internal measurement
    // cache, so a resize that changes rowHeight but leaves rowCount unchanged
    // would otherwise leave every row measured at its old (stale) height.
    useEffect(() => {
      virtualizer.measure();
      // eslint-disable-next-line react-hooks/exhaustive-deps -- only rowHeight should retrigger measure()
    }, [rowHeight]);

    const virtualItems = virtualizer.getVirtualItems();

    // Captures once per cardWidth (a real resize invalidates it, since row
    // height scales with card width) - re-runs virtualizer.measure() above
    // via the rowHeight dependency, replacing the theoretical estimate for
    // every not-yet-rendered row in one pass.
    useEffect(() => {
      if (measuredForCardWidthRef.current === cardWidth) return;
      const measured = virtualItems[0]?.size;
      if (measured == null) return;
      measuredForCardWidthRef.current = cardWidth;
      setMeasuredRowHeight(measured);
    }, [virtualItems, cardWidth]);

    // Always-current values for the rAF-driven jump machinery below.
    const latestRef = useRef({ columnCount, measuredRowHeight, rowCount, virtualizer });
    latestRef.current = { columnCount, measuredRowHeight, rowCount, virtualizer };
    const onJumpCancelledRef = useRef(onJumpCancelled);
    onJumpCancelledRef.current = onJumpCancelled;
    const onJumpSettledRef = useRef(onJumpSettled);
    onJumpSettledRef.current = onJumpSettled;

    // itemIndex plus its settle-loop progress; null once landed, cancelled, or capped out.
    const pendingJumpRef = useRef<{
      itemIndex: number;
      corrections: number;
      startTime: number;
      stableFrames: number;
    } | null>(null);
    const settleFrameRef = useRef<number | null>(null);

    const cancelPendingJump = useCallback(() => {
      if (settleFrameRef.current != null) {
        cancelAnimationFrame(settleFrameRef.current);
        settleFrameRef.current = null;
      }
      if (pendingJumpRef.current) {
        pendingJumpRef.current = null;
        onJumpCancelledRef.current?.();
      }
    }, []);

    // Re-checks the landed row's offset against scrollTop every frame, correcting drift until stable or capped.
    const settleTick = useCallback(() => {
      const pending = pendingJumpRef.current;
      if (!pending) return;
      const { columnCount: cols, virtualizer: v } = latestRef.current;
      const container = containerRef.current;
      if (!container || cols <= 0) {
        settleFrameRef.current = requestAnimationFrame(settleTick);
        return;
      }
      const targetRow = Math.floor(pending.itemIndex / cols);
      const targetOffset = v.getOffsetForIndex?.(targetRow, 'start')?.[0];
      // No way to verify placement without a real offset - treat as landed.
      const drift = targetOffset != null ? Math.abs(container.scrollTop - targetOffset) : 0;

      if (drift <= JUMP_SETTLE_TOLERANCE_PX) {
        pending.stableFrames += 1;
        if (pending.stableFrames >= JUMP_STABLE_FRAMES_REQUIRED) {
          pendingJumpRef.current = null;
          settleFrameRef.current = null;
          onJumpSettledRef.current?.();
          return;
        }
        settleFrameRef.current = requestAnimationFrame(settleTick);
        return;
      }

      pending.stableFrames = 0;
      const elapsed = performance.now() - pending.startTime;
      if (pending.corrections >= JUMP_MAX_CORRECTIONS || elapsed >= JUMP_MAX_DURATION_MS) {
        pendingJumpRef.current = null;
        settleFrameRef.current = null;
        onJumpSettledRef.current?.();
        return;
      }
      pending.corrections += 1;
      v.scrollToIndex(targetRow, { align: 'start' });
      settleFrameRef.current = requestAnimationFrame(settleTick);
    }, []);

    // Never scrolls against an unmeasured instance - retries every frame until layout is real.
    const attemptJump = useCallback(() => {
      const pending = pendingJumpRef.current;
      if (!pending) return;
      const {
        columnCount: cols,
        measuredRowHeight: rh,
        rowCount: rc,
        virtualizer: v,
      } = latestRef.current;
      const ready = hasMeasuredContainerRef.current && cols > 0 && rh !== null && rc > 0;
      if (!ready) {
        settleFrameRef.current = requestAnimationFrame(attemptJump);
        return;
      }
      const targetRow = Math.floor(pending.itemIndex / cols);
      v.scrollToIndex(targetRow, { align: 'start' });
      settleFrameRef.current = requestAnimationFrame(settleTick);
      // eslint-disable-next-line react-hooks/exhaustive-deps -- settleTick is stable ([] deps)
    }, []);

    const beginPendingJump = useCallback(
      (itemIndex: number) => {
        if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current);
        pendingJumpRef.current = {
          itemIndex,
          corrections: 0,
          startTime: performance.now(),
          stableFrames: 0,
        };
        attemptJump();
      },
      [attemptJump]
    );

    // Real input cancels a pending/settling jump immediately - never listens for 'scroll' itself, since scrollToIndex fires that too.
    useEffect(() => {
      const el = containerRef.current;
      if (!el) return;
      const scrollKeys = new Set([
        'ArrowUp',
        'ArrowDown',
        'ArrowLeft',
        'ArrowRight',
        'PageUp',
        'PageDown',
        'Home',
        'End',
        ' ',
      ]);
      const handleWheelOrTouch = () => cancelPendingJump();
      const handlePointerDown = () => cancelPendingJump();
      const handleKeyDown = (event: KeyboardEvent) => {
        if (scrollKeys.has(event.key)) cancelPendingJump();
      };
      el.addEventListener('wheel', handleWheelOrTouch, { passive: true });
      el.addEventListener('touchmove', handleWheelOrTouch, { passive: true });
      el.addEventListener('pointerdown', handlePointerDown);
      el.addEventListener('keydown', handleKeyDown);
      return () => {
        el.removeEventListener('wheel', handleWheelOrTouch);
        el.removeEventListener('touchmove', handleWheelOrTouch);
        el.removeEventListener('pointerdown', handlePointerDown);
        el.removeEventListener('keydown', handleKeyDown);
      };
    }, [cancelPendingJump]);

    useEffect(() => {
      return () => {
        if (settleFrameRef.current != null) cancelAnimationFrame(settleFrameRef.current);
      };
    }, []);

    useImperativeHandle(handleRef, () => ({ scrollToItem: beginPendingJump }), [beginPendingJump]);

    // rowCount is known from totalItems on the first render, so a key this instance hasn't seeked to yet always gets one seek.
    const targetKey = scrollRestore?.key;
    const targetOffset = scrollRestore?.offset;
    useEffect(() => {
      if (rowCount === 0 || appliedScrollRestoreKeyRef.current === targetKey) return;
      appliedScrollRestoreKeyRef.current = targetKey;
      // A new list is being seeded; any jump still settling targets the old one.
      cancelPendingJump();
      const offset =
        targetOffset != null
          ? Math.min(targetOffset, Math.max(virtualizer.getTotalSize() - 1, 0))
          : 0;
      virtualizer.scrollToOffset(offset, { align: 'start' });
      if (targetOffset != null) onScrollRestored?.();
    }, [
      targetKey,
      targetOffset,
      rowCount,
      containerWidth,
      virtualizer,
      onScrollRestored,
      cancelPendingJump,
    ]);

    useEffect(() => {
      if (!onViewportChange) return;
      if (viewportRafRef.current != null) return;
      viewportRafRef.current = requestAnimationFrame(() => {
        viewportRafRef.current = null;
        const first = virtualItems[0];
        const last = virtualItems[virtualItems.length - 1];
        const info = computeViewportInfo(
          first?.index,
          last?.index,
          virtualizer.range?.startIndex,
          columnCount,
          totalItems
        );
        if (info) onViewportChange(info);
      });
      // StrictMode double-invokes effects (mount, cleanup, mount again) in
      // dev; without resetting the ref here too, the cleanup below cancels
      // the first scheduled frame without ever clearing the "one pending
      // frame" guard, permanently wedging it and silently dropping every
      // viewport update - and with it every scroll-driven page fetch and
      // letter-jump landing - for the rest of the component's lifetime.
      return () => {
        if (viewportRafRef.current != null) {
          cancelAnimationFrame(viewportRafRef.current);
          viewportRafRef.current = null;
        }
      };
    }, [virtualItems, columnCount, totalItems, onViewportChange, virtualizer]);

    useEffect(() => {
      const el = containerRef.current;
      if (!el || !onScrollIdle) return;

      const handleScroll = () => {
        if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
        idleTimeoutRef.current = setTimeout(() => onScrollIdle(el.scrollTop), SCROLL_IDLE_MS);
      };

      el.addEventListener('scroll', handleScroll, { passive: true });
      return () => {
        el.removeEventListener('scroll', handleScroll);
        if (idleTimeoutRef.current) clearTimeout(idleTimeoutRef.current);
      };
    }, [onScrollIdle]);

    return (
      <div role="region" aria-label={ariaLabel} className={cn('min-w-0', className)}>
        <div
          ref={containerRef}
          // overflow-anchor: none - rows are absolutely positioned (translateY),
          // not in normal flow, so the browser's scroll-anchoring heuristic
          // mis-anchors to whatever DOM node it likes as new rows mount above
          // the viewport (e.g. right after scrollToIndex) and silently snaps
          // the scroll position back, fighting a programmatic jump.
          className="scrollbar-thin overflow-x-hidden overflow-y-auto [overflow-anchor:none]"
          style={{ height: containerHeight }}
        >
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualItems.map((virtualRow) => {
              const style: CSSProperties = {
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100%',
                transform: `translateY(${virtualRow.start}px)`,
                gridTemplateColumns: `repeat(${columnCount}, minmax(0, 1fr))`,
              };
              const rowStart = virtualRow.index * columnCount;
              const cellCount = Math.min(columnCount, totalItems - rowStart);
              const isEarlyRow = virtualRow.index < 2;

              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={style}
                  className="grid gap-x-[14px] gap-y-4 pb-4"
                >
                  {Array.from({ length: cellCount }, (_, column) => {
                    const row = getRow(rowStart + column);
                    return row ? (
                      <GridCell
                        key={row.mediaId}
                        row={row}
                        serverById={serverById}
                        eager={isEarlyRow}
                      />
                    ) : (
                      <SkeletonCell key={`skeleton-${rowStart + column}`} />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }
);

export { toPosterCardServers };
export type { ServerLookupEntry };
