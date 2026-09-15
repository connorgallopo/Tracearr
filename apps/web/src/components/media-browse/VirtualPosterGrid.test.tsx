import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { createRef } from 'react';
import type { CatalogRow } from '@tracearr/shared';
import {
  computeColumnCount,
  computeRowCount,
  computeCardWidth,
  computeGridHeight,
  computeRowHeight,
  computeViewportInfo,
  MIN_GRID_HEIGHT,
  VirtualPosterGrid,
  type VirtualPosterGridHandle,
} from './VirtualPosterGrid';

const scrollToOffsetMock = vi.hoisted(() => vi.fn());
const scrollToIndexMock = vi.hoisted(() => vi.fn());
// Row 0's "real DOM measurement" - identity by default (matches the
// estimate, like every other test's untouched expectations); a test can
// override it to a distinct value to simulate the estimate being wrong.
const firstRowSizeMock = vi.hoisted(() => vi.fn((estimate: number) => estimate));

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => options.count * options.estimateSize(),
    // Renders the first three rows so cell-level assertions have something
    // mounted; jsdom cannot lay out the real scroll container.
    getVirtualItems: () =>
      Array.from({ length: Math.min(options.count, 3) }, (_, index) => ({
        index,
        key: index,
        start: index * options.estimateSize(),
        size: index === 0 ? firstRowSizeMock(options.estimateSize()) : options.estimateSize(),
      })),
    range: options.count > 0 ? { startIndex: 0, endIndex: Math.min(options.count, 3) - 1 } : null,
    measure: vi.fn(),
    measureElement: vi.fn(),
    scrollToOffset: scrollToOffsetMock,
    scrollToIndex: scrollToIndexMock,
  }),
}));

describe('computeColumnCount', () => {
  it('clamps to a minimum of 2 columns on a narrow container', () => {
    expect(computeColumnCount(300)).toBe(2);
  });

  it('fits 5 columns at 800px (152px per column)', () => {
    expect(computeColumnCount(800)).toBe(5);
  });

  it('fits 10 columns at 1600px', () => {
    expect(computeColumnCount(1600)).toBe(10);
  });

  it('never returns 0 or negative for a zero-width container', () => {
    expect(computeColumnCount(0)).toBe(2);
  });
});

describe('computeCardWidth / computeRowHeight', () => {
  it('derives card width from container width and gap count', () => {
    // 800px, 5 columns, 4 gaps of 14px => (800 - 56) / 5 = 148.8
    expect(computeCardWidth(800, 5)).toBeCloseTo(148.8, 1);
  });

  it('row height is card width * 1.5 plus the 72px two-line-title footer plus the 16px row bottom padding', () => {
    expect(computeRowHeight(140)).toBe(140 * 1.5 + 72 + 16);
  });
});

describe('computeGridHeight', () => {
  it('fills the window below the grid top, less the page bottom padding', () => {
    expect(computeGridHeight(1080, 169, 24)).toBe(887);
  });

  it('stops at MIN_GRID_HEIGHT on a short window', () => {
    expect(computeGridHeight(640, 169, 24)).toBe(MIN_GRID_HEIGHT);
  });
});

describe('computeRowCount', () => {
  it('is the item count divided across columns, rounded up', () => {
    expect(computeRowCount(23, 5)).toBe(Math.ceil(23 / 5));
  });

  it('is 0 for an empty grid', () => {
    expect(computeRowCount(0, 5)).toBe(0);
  });

  it('is 0 when the column count is not yet known', () => {
    expect(computeRowCount(23, 0)).toBe(0);
  });
});

describe('computeViewportInfo', () => {
  it('maps rendered rows and the visible top row to item indices', () => {
    expect(computeViewportInfo(2, 5, 3, 4, 100)).toEqual({
      renderFirstItem: 8,
      renderLastItem: 23,
      topItem: 12,
      columnCount: 4,
    });
  });

  it('clamps the last item to the total', () => {
    expect(computeViewportInfo(0, 5, 0, 4, 10)).toEqual({
      renderFirstItem: 0,
      renderLastItem: 9,
      topItem: 0,
      columnCount: 4,
    });
  });

  it('is null while the virtualizer or layout has not produced a range', () => {
    expect(computeViewportInfo(undefined, 5, 0, 4, 100)).toBeNull();
    expect(computeViewportInfo(0, undefined, 0, 4, 100)).toBeNull();
    expect(computeViewportInfo(0, 5, undefined, 4, 100)).toBeNull();
    expect(computeViewportInfo(0, 5, 0, 0, 100)).toBeNull();
    expect(computeViewportInfo(0, 5, 0, 4, 0)).toBeNull();
  });
});

function makeRow(i: number): CatalogRow {
  return {
    mediaId: `m${i}`,
    mediaType: 'movie' as const,
    title: `Title ${i}`,
    year: 2020,
    genres: [],
    posterUrl: null,
    posterVersion: null,
    dominantColor: null,
    servers: [],
    resolutionBest: null,
    watchedState: 'unwatched' as const,
    watchedStateSelf: 'unwatched' as const,
    plays: 0,
    viewers: 0,
  };
}

const baseGridProps = {
  serverById: new Map(),
  ariaLabel: 'Movies',
};

beforeEach(() => {
  scrollToOffsetMock.mockClear();
  scrollToIndexMock.mockClear();
  firstRowSizeMock.mockReset();
  firstRowSizeMock.mockImplementation((estimate: number) => estimate);
});

describe('sparse rendering', () => {
  it('renders loaded rows as cards and unloaded cells as skeletons in place', () => {
    // jsdom reports a 0px container => 2 columns. Rows 0-1 are loaded, the
    // rest of the total is not.
    const loaded = new Map([0, 1, 2, 3].map((i) => [i, makeRow(i)]));
    const { container } = render(
      <MemoryRouter>
        <VirtualPosterGrid
          {...baseGridProps}
          totalItems={100}
          getRow={(index) => loaded.get(index)}
        />
      </MemoryRouter>
    );
    const links = container.querySelectorAll('a');
    expect(links.length).toBe(4);
    // Third mounted row (items 4,5) has no data: skeleton cells render.
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('sizes the scroll space from the total, not from loaded rows', () => {
    const columnCount = computeColumnCount(0);
    const rowHeight = computeRowHeight(computeCardWidth(0, columnCount));
    const { container } = render(
      <VirtualPosterGrid {...baseGridProps} totalItems={100} getRow={() => undefined} />
    );
    const spacer = container.querySelector('.overflow-y-auto > div') as HTMLDivElement;
    expect(spacer.style.height).toBe(`${Math.ceil(100 / columnCount) * rowHeight}px`);
  });

  it("replaces the theoretical row-height estimate with the first row's real measured height once known", () => {
    // The real DOM row measures taller than the formula predicted - every
    // still-unmeasured row (the whole reason a deep jump used to land short)
    // must be priced with this real number afterward, not the formula.
    firstRowSizeMock.mockImplementation(() => 999);
    const columnCount = computeColumnCount(0);
    const { container, rerender } = render(
      <VirtualPosterGrid {...baseGridProps} totalItems={100} getRow={() => undefined} />
    );
    // Re-render so the measured-height state update (scheduled by the
    // mount-time effect) is reflected in the next getTotalSize() call.
    rerender(<VirtualPosterGrid {...baseGridProps} totalItems={100} getRow={() => undefined} />);

    const spacer = container.querySelector('.overflow-y-auto > div') as HTMLDivElement;
    expect(spacer.style.height).toBe(`${Math.ceil(100 / columnCount) * 999}px`);
  });
});

describe('scrollToItem handle', () => {
  it('scrolls to the grid row containing the item, aligned to start', () => {
    const ref = createRef<VirtualPosterGridHandle>();
    render(
      <VirtualPosterGrid {...baseGridProps} ref={ref} totalItems={100} getRow={() => undefined} />
    );
    const columnCount = computeColumnCount(0);
    ref.current!.scrollToItem(11);
    expect(scrollToIndexMock).toHaveBeenCalledWith(Math.floor(11 / columnCount), {
      align: 'start',
    });
  });

  it('defers the scroll until the first row has a real measured height, instead of scrolling against an unmeasured instance', async () => {
    firstRowSizeMock.mockImplementation(() => undefined as unknown as number);
    const ref = createRef<VirtualPosterGridHandle>();
    const { rerender } = render(
      <VirtualPosterGrid {...baseGridProps} ref={ref} totalItems={100} getRow={() => undefined} />
    );

    ref.current!.scrollToItem(11);
    expect(scrollToIndexMock).not.toHaveBeenCalled();

    // The instance becomes measured (a real row height arrives) - the queued jump then applies.
    firstRowSizeMock.mockImplementation((estimate: number) => estimate);
    rerender(
      <VirtualPosterGrid {...baseGridProps} ref={ref} totalItems={100} getRow={() => undefined} />
    );

    await waitFor(() => expect(scrollToIndexMock).toHaveBeenCalled());
  });

  it('fires onJumpSettled once the landed row is confirmed stable', async () => {
    const onJumpSettled = vi.fn();
    const ref = createRef<VirtualPosterGridHandle>();
    render(
      <VirtualPosterGrid
        {...baseGridProps}
        ref={ref}
        totalItems={100}
        getRow={() => undefined}
        onJumpSettled={onJumpSettled}
      />
    );
    ref.current!.scrollToItem(11);
    await waitFor(() => expect(onJumpSettled).toHaveBeenCalledTimes(1));
  });
});

describe('jump cancellation on real user input', () => {
  function scrollContainer(container: HTMLElement) {
    return container.querySelector('.overflow-y-auto') as HTMLElement;
  }

  it('cancels a pending jump on a real wheel scroll, never on the scrollToIndex call itself', () => {
    const onJumpCancelled = vi.fn();
    const ref = createRef<VirtualPosterGridHandle>();
    const { container } = render(
      <VirtualPosterGrid
        {...baseGridProps}
        ref={ref}
        totalItems={100}
        getRow={() => undefined}
        onJumpCancelled={onJumpCancelled}
      />
    );
    ref.current!.scrollToItem(11);
    expect(onJumpCancelled).not.toHaveBeenCalled();

    fireEvent.wheel(scrollContainer(container));
    expect(onJumpCancelled).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending jump on a scroll-relevant keydown', () => {
    const onJumpCancelled = vi.fn();
    const ref = createRef<VirtualPosterGridHandle>();
    const { container } = render(
      <VirtualPosterGrid
        {...baseGridProps}
        ref={ref}
        totalItems={100}
        getRow={() => undefined}
        onJumpCancelled={onJumpCancelled}
      />
    );
    ref.current!.scrollToItem(11);
    fireEvent.keyDown(scrollContainer(container), { key: 'ArrowDown' });
    expect(onJumpCancelled).toHaveBeenCalledTimes(1);
  });

  it('ignores an unrelated keydown (e.g. typing) - only scroll keys cancel', () => {
    const onJumpCancelled = vi.fn();
    const ref = createRef<VirtualPosterGridHandle>();
    const { container } = render(
      <VirtualPosterGrid
        {...baseGridProps}
        ref={ref}
        totalItems={100}
        getRow={() => undefined}
        onJumpCancelled={onJumpCancelled}
      />
    );
    ref.current!.scrollToItem(11);
    fireEvent.keyDown(scrollContainer(container), { key: 'a' });
    expect(onJumpCancelled).not.toHaveBeenCalled();
  });

  it('cancels a pending jump on a pointerdown (scrollbar drag / content click)', () => {
    const onJumpCancelled = vi.fn();
    const ref = createRef<VirtualPosterGridHandle>();
    const { container } = render(
      <VirtualPosterGrid
        {...baseGridProps}
        ref={ref}
        totalItems={100}
        getRow={() => undefined}
        onJumpCancelled={onJumpCancelled}
      />
    );
    ref.current!.scrollToItem(11);
    fireEvent.pointerDown(scrollContainer(container));
    expect(onJumpCancelled).toHaveBeenCalledTimes(1);
  });

  it('does not report a cancellation when there is no jump in flight', () => {
    const onJumpCancelled = vi.fn();
    const { container } = render(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={100}
        getRow={() => undefined}
        onJumpCancelled={onJumpCancelled}
      />
    );
    fireEvent.wheel(scrollContainer(container));
    expect(onJumpCancelled).not.toHaveBeenCalled();
  });
});

describe('scroll restore', () => {
  it('restores once on mount and never re-issues', () => {
    const { rerender } = render(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={500}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: 4000 }}
      />
    );
    expect(scrollToOffsetMock).toHaveBeenCalledTimes(1);
    expect(scrollToOffsetMock.mock.calls[0]?.[0]).toBe(4000);

    rerender(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={500}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: 4000 }}
      />
    );
    expect(scrollToOffsetMock).toHaveBeenCalledTimes(1);
  });

  it('clamps a stale offset that runs past the total scroll space', () => {
    const columnCount = computeColumnCount(0);
    const rowHeight = computeRowHeight(computeCardWidth(0, columnCount));
    const totalSize = Math.ceil(10 / columnCount) * rowHeight;
    render(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={10}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: totalSize * 50 }}
      />
    );
    expect(scrollToOffsetMock).toHaveBeenCalledTimes(1);
    expect(scrollToOffsetMock.mock.calls[0]?.[0]).toBeLessThan(totalSize);
  });

  it('calls onScrollRestored once the offset is applied, so the parent can clear it', () => {
    const onScrollRestored = vi.fn();
    render(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={500}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: 4000 }}
        onScrollRestored={onScrollRestored}
      />
    );
    expect(onScrollRestored).toHaveBeenCalledTimes(1);
  });

  it('does not call onScrollRestored when there is nothing to restore', () => {
    const onScrollRestored = vi.fn();
    render(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={500}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: null }}
        onScrollRestored={onScrollRestored}
      />
    );
    expect(onScrollRestored).not.toHaveBeenCalled();
  });

  it('re-seeks when the scrollRestore key changes, even without unmounting (movie <-> show toggle)', () => {
    const { rerender } = render(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={500}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: 4000 }}
      />
    );
    expect(scrollToOffsetMock).toHaveBeenCalledTimes(1);
    expect(scrollToOffsetMock.mock.calls[0]?.[0]).toBe(4000);

    // Switching to shows with no saved offset for that list must land at the
    // top, not keep movies' scrollTop - the grid instance never remounts.
    rerender(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={200}
        getRow={() => undefined}
        scrollRestore={{ key: 'show', offset: null }}
      />
    );
    expect(scrollToOffsetMock).toHaveBeenCalledTimes(2);
    expect(scrollToOffsetMock.mock.calls[1]?.[0]).toBe(0);
  });

  it('cancels an in-flight jump when the scrollRestore key changes mid-settle', () => {
    const onJumpCancelled = vi.fn();
    const ref = createRef<VirtualPosterGridHandle>();
    const { rerender } = render(
      <VirtualPosterGrid
        {...baseGridProps}
        ref={ref}
        totalItems={500}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: null }}
        onJumpCancelled={onJumpCancelled}
      />
    );
    act(() => {
      ref.current?.scrollToItem(300);
    });

    // Toggling to the other list must not leave the movies jump settling
    // against the shows grid.
    rerender(
      <VirtualPosterGrid
        {...baseGridProps}
        ref={ref}
        totalItems={200}
        getRow={() => undefined}
        scrollRestore={{ key: 'show', offset: null }}
        onJumpCancelled={onJumpCancelled}
      />
    );
    expect(onJumpCancelled).toHaveBeenCalledTimes(1);
  });

  it('applies the offset already present on the very first render pass - the cached-mount case, where rowCount>0 from render one', () => {
    // Rendering directly with data present (no isLoading gap) simulates a
    // React Query cache hit: scrollRestore must already carry the right
    // offset by the time this first pass runs, since there is no second
    // chance - a key is only ever consumed once.
    render(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={500}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: 3200 }}
      />
    );
    expect(scrollToOffsetMock).toHaveBeenCalledTimes(1);
    expect(scrollToOffsetMock.mock.calls[0]?.[0]).toBe(3200);
  });

  it('never re-applies an already-consumed key even if its offset changes afterward', () => {
    const onScrollRestored = vi.fn();
    const { rerender } = render(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={500}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: 4000 }}
        onScrollRestored={onScrollRestored}
      />
    );
    expect(scrollToOffsetMock).toHaveBeenCalledTimes(1);

    // The parent clears the offset for the same key once restored (its own
    // onScrollRestored handler) - must not trigger a second seek to top.
    rerender(
      <VirtualPosterGrid
        {...baseGridProps}
        totalItems={500}
        getRow={() => undefined}
        scrollRestore={{ key: 'movie', offset: null }}
        onScrollRestored={onScrollRestored}
      />
    );
    expect(scrollToOffsetMock).toHaveBeenCalledTimes(1);
  });
});
