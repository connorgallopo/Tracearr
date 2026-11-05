import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router';
import type { LibraryMediaType, WatchedState } from '@tracearr/shared';
import { AlphabetScrubber, type ScrubberLetter } from '@/components/media-browse/AlphabetScrubber';
import {
  CatalogToolbar,
  filtersForType,
  visibleSort,
  activeFilterCount,
  loadPersistedFilters,
  persistFilters,
  validatePersistedFilters,
  librariesForGridType,
  libraryKeyFor,
  DEFAULT_GRID_FILTERS,
  type PersistedGridFilters,
} from '@/components/media-browse/CatalogToolbar';
import {
  VirtualPosterGrid,
  computeColumnCount,
  type VirtualPosterGridHandle,
  type ViewportInfo,
  type ScrollRestoreTarget,
} from '@/components/media-browse/VirtualPosterGrid';
import { POSTER_ASPECT_CLASS, type PosterAspect } from '@/components/media-browse/PosterCard';
import { LibraryEmptyState } from '@/components/library/LibraryEmptyState';
import { ErrorState, InlineErrorState } from '@/components/library/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import {
  useCatalogWindow,
  useCatalogLetters,
  useDashboardStats,
  useGenres,
  useCatalogCodecs,
  useLibraries,
  buildLetterOffsets,
  activeLetterForRow,
  pageIndicesForRange,
  stableSerialize,
  CATALOG_PAGE_SIZE,
} from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useMediaType } from '@/hooks/useMediaType';
import { useServer } from '@/hooks/useServer';
import { useIsMobile } from '@/hooks/use-mobile';
import { cn } from '@/lib/utils';

const WATCHED_STATES: readonly WatchedState[] = ['watched', 'partial', 'unwatched'];

/** Filters a link can set on arrival: `?genre=` from the Genres page,
 * resolution, codec, channel and server params from the Quality page charts,
 * `?watched=` from a member's "Not watched by you" link, and `?addedAfter=` /
 * `?addedBefore=` from the Overview's growth chart. */
function linkedFilters(search: string): Partial<PersistedGridFilters> {
  const params = new URLSearchParams(search);
  const linked: Partial<PersistedGridFilters> = {};
  for (const key of [
    'genre',
    'resolution',
    'videoCodec',
    'audioCodec',
    'audioChannels',
    'serverId',
  ] as const) {
    const value = params.get(key);
    if (value) linked[key] = value;
  }
  const watched = params.get('watched');
  const watchedState = WATCHED_STATES.find((state) => state === watched);
  if (watchedState) linked.watched = watchedState;
  const addedAfter = params.get('addedAfter') ?? undefined;
  const addedBefore = params.get('addedBefore') ?? undefined;
  if (addedAfter || addedBefore) linked.added = { from: addedAfter, to: addedBefore };
  return linked;
}

const GRID_TITLE_KEYS = {
  movie: 'media.movies.title',
  show: 'media.shows.title',
  artist: 'common:media.artist_plural',
} as const satisfies Record<LibraryMediaType, string>;

interface GridHistoryState {
  type: LibraryMediaType;
  offset: number;
}

function readHistoryState(type: LibraryMediaType): GridHistoryState | null {
  const raw = window.history.state as { mediaGrid?: GridHistoryState } | null;
  const mediaGrid = raw?.mediaGrid;
  return mediaGrid?.type === type ? mediaGrid : null;
}

interface BrowseLocationState {
  /** Set by the media type control's nav so the target list lands at the top
   * with default filters, instead of restoring whatever this type last had. */
  freshBrowse?: boolean;
}

function isFreshBrowse(state: unknown): boolean {
  return Boolean((state as BrowseLocationState | null)?.freshBrowse);
}

/** Drops any saved scroll offset from the current history entry so an
 * organic (non-toggle) visit later can't resurrect a stale deep offset. */
function clearHistoryOffset(): void {
  const raw = { ...(window.history.state as Record<string, unknown> | null) };
  delete raw.mediaGrid;
  window.history.replaceState(raw, '');
}

/** Consumes the one-shot fresh-toggle flag from the current history entry;
 * without this, Back/Forward into this entry would re-apply the fresh reset
 * and wipe whatever the viewer customized here since. */
function consumeFreshBrowseFlag(): void {
  const raw = { ...(window.history.state as Record<string, unknown> | null) };
  const usr = raw.usr;
  if (!usr || typeof usr !== 'object' || !(usr as BrowseLocationState).freshBrowse) return;
  const nextUsr = { ...(usr as Record<string, unknown>) };
  delete nextUsr.freshBrowse;
  window.history.replaceState({ ...raw, usr: nextUsr }, '');
}

/**
 * Static skeleton grid rendered before the first window (and its total) has
 * arrived. Measures its own width and runs it through the same
 * computeColumnCount the real VirtualPosterGrid uses, so the column count
 * here matches the one the real grid lands on - a mismatch (e.g. from the
 * CSS auto-fill algorithm rounding differently, or not accounting for the
 * letter-rail column) shows up as layout shift the moment data arrives.
 */
function StaticSkeletonGrid({ aspect }: { aspect: PosterAspect }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [columnCount, setColumnCount] = useState(2);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width != null) setColumnCount(computeColumnCount(width));
    });
    observer.observe(el);
    setColumnCount(computeColumnCount(el.clientWidth));
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={containerRef}
      data-testid="grid-first-mount-skeleton"
      className="grid gap-x-[14px] gap-y-4"
      style={{ gridTemplateColumns: `repeat(${columnCount}, 1fr)` }}
    >
      {Array.from({ length: 18 }).map((_, index) => (
        <div key={index} className="space-y-1.5">
          <Skeleton className={cn('w-full rounded-md', POSTER_ASPECT_CLASS[aspect])} />
          <Skeleton className="h-3.5 w-full" />
        </div>
      ))}
    </div>
  );
}

export function MediaGrid() {
  const { t } = useTranslation(['pages', 'common']);
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const queryClient = useQueryClient();
  const { selectedServerIds, servers, isLoading: serversLoading } = useServer();
  const { user } = useAuth();
  const isMember = user?.role === 'member';
  // The server leaves othersActive out of the dashboard stats exactly when it
  // withholds popularity data from members.
  const seesActivity =
    useDashboardStats(selectedServerIds, { enabled: isMember, keepPrevious: true }).data
      ?.othersActive !== undefined;
  const hidePopularitySorts = isMember && !seesActivity;

  const { value: type } = useMediaType();
  const aspect: PosterAspect = type === 'artist' ? 'square' : 'poster';
  const gridTitle = t(GRID_TITLE_KEYS[type]);

  const [storedFilters, setFilters] = useState<PersistedGridFilters>(() =>
    loadPersistedFilters(type)
  );
  // Derived at render: the render that first sees a new type still holds the
  // previous type's filters, and its requests must already fit the new type.
  const filters = useMemo(() => filtersForType(storedFilters, type), [storedFilters, type]);
  const sort = visibleSort(filters.sort, hidePopularitySorts);
  const [search, setSearch] = useState('');
  const [activeLetter, setActiveLetter] = useState<ScrubberLetter | null>(null);
  // Seeded synchronously so the very first render already has the right offset (needed for the cached-data mount path).
  const [scrollRestore, setScrollRestore] = useState<ScrollRestoreTarget>(() => ({
    key: type,
    offset: readHistoryState(type)?.offset ?? null,
  }));
  const [viewport, setViewport] = useState<ViewportInfo | null>(null);
  // Target item of a letter jump still settling in the grid; holds the rail on the clicked letter until the grid reports landed or cancelled.
  const [pendingJumpItem, setPendingJumpItem] = useState<number | null>(null);
  const gridRef = useRef<VirtualPosterGridHandle>(null);
  // Marks the default filters object handed to setFilters for a fresh toggle
  // landing, so the persist effect can skip both the stale pre-reset render
  // it fires on immediately and the reset render that follows it - a fresh
  // toggle's transient landing state is never written back to storage.
  const suppressedFiltersRef = useRef<PersistedGridFilters | null>(null);

  // Updated during render (not an effect) so the new type's offset lands in the same commit as the key change.
  if (scrollRestore.key !== type) {
    setScrollRestore({
      key: type,
      offset: isFreshBrowse(location.state) ? null : (readHistoryState(type)?.offset ?? null),
    });
  }

  /** Artists have no watched state or year; a link carrying either loses it. */
  const dropArtistParams = (search: string, state: unknown) => {
    const params = new URLSearchParams(search);
    const hadParams = params.has('watched') || params.get('sort') === 'year';
    params.delete('watched');
    if (params.get('sort') === 'year') params.delete('sort');
    if (hadParams) void navigate({ search: `?${params.toString()}` }, { replace: true, state });
  };

  // Filters/search are per media type; reset them (rather than relying on a
  // route remount, which react-router doesn't guarantee here) whenever the
  // media type control changes the route.
  useEffect(() => {
    if (isFreshBrowse(location.state)) {
      // The media type control: always land at the top with default filters
      // and empty search, ignoring whatever this type had saved.
      const freshFilters = { ...DEFAULT_GRID_FILTERS };
      suppressedFiltersRef.current = freshFilters;
      setFilters(freshFilters);
      clearHistoryOffset();
      consumeFreshBrowseFlag();
    } else {
      // Link params (see linkedFilters) seed the persisted filters for this
      // type on arrival. Read only on this type transition itself - re-running
      // on every location.search change would fight the toolbar's own filter
      // state once the viewer edits filters.
      setFilters({ ...loadPersistedFilters(type), ...linkedFilters(location.search) });
      if (type === 'artist') dropArtistParams(location.search, location.state);
    }
    setSearch('');
    setActiveLetter(null);
    setViewport(null);
    setPendingJumpItem(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type]);

  // A pending scroll restore only ever applies to the list it was captured
  // from - once the viewer edits search or filters the result set changes
  // shape, so any deep offset still queued here would otherwise land the
  // grid somewhere nonsensical (often past the end) the moment it reloads.
  // A pending letter-jump re-align is stale for the same reason.
  const handleSearchChange = useCallback((next: string) => {
    setScrollRestore((prev) => ({ key: prev.key, offset: null }));
    setPendingJumpItem(null);
    setSearch(next);
  }, []);

  const handleFiltersChange = useCallback((next: PersistedGridFilters) => {
    setScrollRestore((prev) => ({ key: prev.key, offset: null }));
    setPendingJumpItem(null);
    setFilters(next);
  }, []);

  const serverById = useMemo(
    () =>
      new Map(
        servers.map((server) => [
          server.id,
          { name: server.name, type: server.type, color: server.color },
        ])
      ),
    [servers]
  );

  const genresQuery = useGenres(type, selectedServerIds);
  const genresData = genresQuery.data;
  const genres = useMemo(() => genresData?.data ?? [], [genresData]);
  const genreNames = useMemo(
    () => (genresData ? genres.map((g) => g.genre) : undefined),
    [genresData, genres]
  );

  const codecsData = useCatalogCodecs(type, selectedServerIds).data;

  const librariesQuery = useLibraries(selectedServerIds);
  const librariesData = librariesQuery.data;
  const gridLibraries = useMemo(
    () => librariesForGridType(librariesData?.data ?? [], type),
    [librariesData, type]
  );
  const libraryKeys = useMemo(
    () => (librariesData ? gridLibraries.map(libraryKeyFor) : undefined),
    [librariesData, gridLibraries]
  );

  // Drop filter values that no longer resolve - a genre absent from the
  // current scope, a server filter pointing outside the current selection, or
  // a library absent from the fetched list (validating against the
  // SELECTION, not all servers, is what keeps a stale filter from silently
  // widening the grid to every server once its target is deselected). Only
  // runs once the data it validates against has actually loaded - never on a
  // transient loading/error render. Bails out to the same `prev` reference
  // when nothing changed so this can't spin into a render loop even if an
  // upstream query result reference churns.
  useEffect(() => {
    if (selectedServerIds.length === 0 && !genresData && !librariesData) return;
    setFilters((prev) => {
      const next = validatePersistedFilters(prev, {
        serverIds: selectedServerIds,
        genres: genreNames,
        libraryKeys,
      });
      if (
        next.serverId === prev.serverId &&
        next.genre === prev.genre &&
        next.libraryKey === prev.libraryKey
      ) {
        return prev;
      }
      return next;
    });
  }, [selectedServerIds, genreNames, genresData, libraryKeys, librariesData]);

  useEffect(() => {
    if (suppressedFiltersRef.current) {
      if (storedFilters === suppressedFiltersRef.current) suppressedFiltersRef.current = null;
      return;
    }
    persistFilters(type, filtersForType(storedFilters, type));
  }, [type, storedFilters]);

  // An explicit single-element array when the server filter is set - never
  // an intersection that could collapse to [] and be read as "unscoped".
  const catalogServerIds = filters.serverId ? [filters.serverId] : selectedServerIds;

  const catalogArgs = {
    type,
    serverIds: catalogServerIds,
    // Watched means "any user has watched it" for staff. A member's lens is
    // their own identity, since the server would otherwise list what others watched.
    lens: isMember && user ? user.userId : 'all',
    filters: {
      resolution: filters.resolution,
      genre: filters.genre,
      yearFrom: filters.yearFrom,
      yearTo: filters.yearTo,
      watched: filters.watched,
      search: search || undefined,
      libraryKey: filters.libraryKey,
      hdr: filters.hdr,
      atmos: filters.atmos,
      sizeGbMin: filters.sizeGbMin,
      sizeGbMax: filters.sizeGbMax,
      videoCodec: filters.videoCodec,
      audioCodec: filters.audioCodec,
      audioChannels: filters.audioChannels,
      addedAfter: filters.added?.from,
      addedBefore: filters.added?.to,
    },
    sort,
  };

  const lettersQuery = useCatalogLetters(catalogArgs);
  const letterOffsets = useMemo(
    () => (lettersQuery.data ? buildLetterOffsets(lettersQuery.data.letters) : undefined),
    [lettersQuery.data]
  );

  const neededPages = useMemo(() => {
    if (!viewport) return [0];
    return pageIndicesForRange(viewport.renderFirstItem, viewport.renderLastItem, null);
  }, [viewport]);

  const {
    pages,
    totalItems: windowTotalItems,
    totalFileSize: windowTotalFileSize,
    isError,
    error,
    pageError,
    retryErroredPages,
  } = useCatalogWindow(catalogArgs, neededPages);

  // A synced-but-empty catalog is a successful query, so retryErroredPages
  // alone won't pick up titles a sync just added; invalidate media queries too.
  const handleEmptyStateComplete = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['media'] });
    retryErroredPages();
  }, [queryClient, retryErroredPages]);

  // Sticks to the last known total for this exact result set - the active page window only covers the viewport's current pages, so a jump to unloaded pages would otherwise drop totalItems to null and flash the full skeleton.
  const resultSetKey = stableSerialize({
    type,
    serverIds: [...catalogServerIds].sort(),
    filters: catalogArgs.filters,
    sort,
  });
  const knownTotalsRef = useRef<{ key: string; totalItems: number; totalFileSize: number } | null>(
    null
  );
  if (knownTotalsRef.current?.key !== resultSetKey) knownTotalsRef.current = null;
  if (windowTotalItems !== null) {
    knownTotalsRef.current = {
      key: resultSetKey,
      totalItems: windowTotalItems,
      totalFileSize: windowTotalFileSize ?? 0,
    };
  }
  const totalItems = windowTotalItems ?? knownTotalsRef.current?.totalItems ?? null;
  const totalFileSize = windowTotalFileSize ?? knownTotalsRef.current?.totalFileSize ?? null;

  const getRow = useCallback(
    (index: number) => {
      const page = pages.get(Math.floor(index / CATALOG_PAGE_SIZE));
      return page?.[index % CATALOG_PAGE_SIZE];
    },
    [pages]
  );

  const handleViewportChange = useCallback(
    (info: ViewportInfo) => {
      setViewport((prev) =>
        prev?.renderFirstItem === info.renderFirstItem &&
        prev?.renderLastItem === info.renderLastItem &&
        prev?.topItem === info.topItem
          ? prev
          : info
      );
      // While a jump is still settling, trust the clicked letter over the transient topItem reading.
      if (sort === 'title' && pendingJumpItem === null) {
        const letter = activeLetterForRow(
          info.topItem,
          info.columnCount,
          letterOffsets
        ) as ScrubberLetter | null;
        if (letter) setActiveLetter(letter);
      }
    },
    [sort, letterOffsets, pendingJumpItem]
  );

  const handleScrollIdle = useCallback(
    (offset: number) => {
      // Spread the existing entry: react-router keeps its own state (usr/key/
      // idx) in history.state, and replacing the whole object would break
      // back/forward handling app-wide.
      window.history.replaceState(
        {
          ...(window.history.state as Record<string, unknown> | null),
          mediaGrid: { type, offset } satisfies GridHistoryState,
        },
        ''
      );
    },
    [type]
  );

  const handleJump = (letter: ScrubberLetter) => {
    const bucket = letterOffsets?.find((entry) => entry.letter === letter);
    if (!bucket || bucket.count === 0) return;
    setActiveLetter(letter);
    setPendingJumpItem(bucket.start);
    gridRef.current?.scrollToItem(bucket.start);
  };

  const handleTypeChange = (nextType: LibraryMediaType) => {
    void navigate(`/media/browse${nextType === 'movie' ? '' : `?type=${nextType}`}`, {
      state: { freshBrowse: true } satisfies BrowseLocationState,
    });
  };

  const hasNoServers = !serversLoading && selectedServerIds.length === 0;
  const isEmpty = !isError && totalItems === 0;
  const hasSearch = search.trim().length > 0;
  const hasFilters = activeFilterCount(filters) > 0;

  const emptyVariant: 'search' | 'filter' | 'library' | null = !isEmpty
    ? null
    : hasSearch
      ? 'search'
      : hasFilters
        ? 'filter'
        : 'library';

  const showScrubber = sort === 'title';

  const header = <h1 className="sr-only">{gridTitle}</h1>;

  if (hasNoServers) {
    return (
      <div className="space-y-6">
        {header}
        <LibraryEmptyState onComplete={handleEmptyStateComplete} />
      </div>
    );
  }

  const scrubber = (
    <AlphabetScrubber
      activeLetter={activeLetter}
      onJump={handleJump}
      letters={lettersQuery.data?.letters}
      variant="rail"
    />
  );
  const mobileScrubber = (
    <AlphabetScrubber
      activeLetter={activeLetter}
      onJump={handleJump}
      letters={lettersQuery.data?.letters}
      variant="select"
    />
  );

  return (
    <div className="space-y-4">
      {header}

      <CatalogToolbar
        type={type}
        onTypeChange={handleTypeChange}
        search={search}
        onSearchChange={handleSearchChange}
        filters={filters}
        onFiltersChange={handleFiltersChange}
        genres={genres}
        servers={servers.map((s) => ({ id: s.id, name: s.name, historicalAt: s.historicalAt }))}
        libraries={gridLibraries}
        videoCodecs={codecsData?.video ?? []}
        audioCodecs={codecsData?.audio ?? []}
        audioChannelOptions={codecsData?.channels ?? []}
        totalItems={totalItems ?? undefined}
        totalFileSize={totalFileSize ?? undefined}
        mobileScrubber={showScrubber ? mobileScrubber : null}
        hidePopularitySorts={hidePopularitySorts}
      />

      {totalItems === null ? (
        isError ? (
          <ErrorState
            message={error?.message ?? t('media.grid.loadError')}
            onRetry={retryErroredPages}
          />
        ) : (
          // Reserves the same letter-rail column the loaded grid below uses,
          // so the skeleton measures the same width computeColumnCount will
          // see once the real grid mounts into it.
          <div
            className="grid gap-2"
            style={{ gridTemplateColumns: isMobile || !showScrubber ? '1fr' : '1fr 26px' }}
          >
            <StaticSkeletonGrid aspect={aspect} />
          </div>
        )
      ) : emptyVariant === 'library' ? (
        <LibraryEmptyState onComplete={handleEmptyStateComplete} />
      ) : (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: isMobile || !showScrubber ? '1fr' : '1fr 26px' }}
        >
          {emptyVariant ? (
            <EmptyState
              title={
                emptyVariant === 'search'
                  ? t('media.grid.emptySearch', { query: search })
                  : t('media.grid.emptyFilter')
              }
            />
          ) : (
            <div className="min-w-0 space-y-3">
              <VirtualPosterGrid
                key={aspect}
                ref={gridRef}
                totalItems={totalItems}
                getRow={getRow}
                serverById={serverById}
                ariaLabel={gridTitle}
                aspect={aspect}
                onViewportChange={handleViewportChange}
                scrollRestore={scrollRestore}
                onScrollRestored={() =>
                  setScrollRestore((prev) => ({ key: prev.key, offset: null }))
                }
                onScrollIdle={handleScrollIdle}
                onJumpCancelled={() => setPendingJumpItem(null)}
                onJumpSettled={() => setPendingJumpItem(null)}
              />
              {pageError && (
                <InlineErrorState
                  message={t('media.grid.loaderError')}
                  onRetry={retryErroredPages}
                />
              )}
            </div>
          )}
          {!isMobile && showScrubber && scrubber}
        </div>
      )}
    </div>
  );
}
