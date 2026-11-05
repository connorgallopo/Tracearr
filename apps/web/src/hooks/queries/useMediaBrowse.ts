import { useInfiniteQuery, useQueries, useQuery, type QueryClient } from '@tanstack/react-query';
import type {
  CatalogLetterBucket,
  CatalogResponse,
  CatalogRow,
  CatalogRowServerEntry,
  LibraryMediaType,
  MediaDetailResponse,
  MediaSeasonHeatResponse,
  ShelfRow,
  ShelvesResponse,
  WatchedState,
} from '@tracearr/shared';
import { api, type MediaHistoryPageResponse, type StatsTimeRange } from '@/lib/api';
import { browserTimeZone } from '@/lib/dateFormat';

export type CatalogSort = 'title' | 'added' | 'year' | 'plays' | 'watch_time' | 'viewers';

export interface CatalogFilters {
  resolution?: string;
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  watched?: WatchedState;
  search?: string;
  /** `${serverId}:${libraryId}` - see CatalogToolbar. */
  libraryKey?: string;
  hdr?: boolean;
  atmos?: boolean;
  sizeGbMin?: number;
  sizeGbMax?: number;
  /** Display names as the codec charts show them. */
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: string;
  /** Calendar days, inclusive. */
  addedAfter?: string;
  addedBefore?: string;
}

/**
 * JSON.stringify with keys sorted at every object level, so two filter
 * objects with the same entries in a different order collapse to the same
 * query key regardless of how the caller built them.
 */
export function stableSerialize(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

export interface UseCatalogArgs {
  type: LibraryMediaType;
  serverIds: string[];
  lens: string;
  filters: CatalogFilters;
  sort: CatalogSort;
}

/** Rows per catalog window; the grid addresses pages as offset = page * size. */
export const CATALOG_PAGE_SIZE = 60;

function catalogBaseKey(args: {
  type: LibraryMediaType;
  sortedServerIds: string[];
  lens: string;
  filters: CatalogFilters;
  sort: CatalogSort;
}) {
  return [
    'media',
    'catalog',
    args.type,
    args.sortedServerIds.join(','),
    args.lens,
    stableSerialize(args.filters),
    args.sort,
  ] as const;
}

function catalogRequestParams(args: UseCatalogArgs & { sortedServerIds: string[] }) {
  const { type, sortedServerIds, lens, filters, sort } = args;
  return {
    type,
    serverIds: sortedServerIds.length > 0 ? sortedServerIds : undefined,
    lens,
    resolution: filters.resolution,
    genre: filters.genre,
    yearFrom: filters.yearFrom,
    yearTo: filters.yearTo,
    watched: filters.watched,
    search: filters.search,
    sort,
    libraryKey: filters.libraryKey,
    hdr: filters.hdr,
    atmos: filters.atmos,
    sizeGbMin: filters.sizeGbMin,
    sizeGbMax: filters.sizeGbMax,
    videoCodec: filters.videoCodec,
    audioCodec: filters.audioCodec,
    audioChannels: filters.audioChannels,
    addedAfter: filters.addedAfter,
    addedBefore: filters.addedBefore,
  };
}

/**
 * Sparse page windows over the fixed-total catalog ordering: one query per
 * visible page index, keyed under a shared base key so pages persist in the
 * cache while the viewer scrolls. The page list is what the virtualized
 * grid's viewport currently needs - nothing else is fetched or retained in
 * component state.
 */
export interface CatalogWindowResult {
  pages: Map<number, CatalogRow[]>;
  totalItems: number | null;
  totalFileSize: number | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isFetching: boolean;
  /** True when any needed page query is in error (visible or not). */
  pageError: boolean;
  retryErroredPages: () => void;
}

export function useCatalogWindow(args: UseCatalogArgs, pageIndices: number[]): CatalogWindowResult {
  const sortedServerIds = [...args.serverIds].sort();
  const baseKey = catalogBaseKey({ ...args, sortedServerIds });
  const params = catalogRequestParams({ ...args, sortedServerIds });

  const results = useQueries({
    queries: pageIndices.map((pageIndex) => ({
      queryKey: [...baseKey, 'page', pageIndex] as const,
      queryFn: (): Promise<CatalogResponse> =>
        api.library.catalog({
          ...params,
          offset: pageIndex * CATALOG_PAGE_SIZE,
          pageSize: CATALOG_PAGE_SIZE,
        }),
      gcTime: 30 * 60_000,
      staleTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      structuralSharing: false,
    })),
  });

  const pages = new Map<number, CatalogRow[]>();
  let totalItems: number | null = null;
  let totalFileSize: number | null = null;
  results.forEach((result, i) => {
    const pageIndex = pageIndices[i];
    if (pageIndex === undefined || !result.data) return;
    pages.set(pageIndex, result.data.data);
    totalItems = result.data.meta.totalItems;
    totalFileSize = result.data.meta.totalFileSize;
  });

  const firstResult = results[0];
  return {
    pages,
    totalItems,
    totalFileSize,
    isLoading: totalItems === null && results.some((result) => result.isLoading),
    isError: totalItems === null && !!firstResult?.isError,
    error: firstResult?.error ?? null,
    isFetching: results.some((result) => result.isFetching),
    pageError: results.some((result) => result.isError),
    retryErroredPages: () => {
      for (const result of results) {
        if (result.isError) void result.refetch();
      }
    },
  };
}

/** Per-letter bucket counts for the rail; only meaningful under title sort
 * (the endpoint returns an empty set for any other sort). */
export function useCatalogLetters(args: UseCatalogArgs) {
  const sortedServerIds = [...args.serverIds].sort();
  return useQuery({
    queryKey: [...catalogBaseKey({ ...args, sortedServerIds }), 'letters'] as const,
    queryFn: () => api.library.catalogLetters(catalogRequestParams({ ...args, sortedServerIds })),
    staleTime: 5 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    enabled: args.sort === 'title',
  });
}

export interface LetterOffset {
  letter: string;
  count: number;
  /** Absolute row offset of this bucket's first title. */
  start: number;
}

/** Cumulative letter -> starting row offset, in rail order ('#' then A-Z). */
export function buildLetterOffsets(letters: CatalogLetterBucket[]): LetterOffset[] {
  const offsets: LetterOffset[] = [];
  let start = 0;
  for (const bucket of letters) {
    offsets.push({ letter: bucket.letter, count: bucket.count, start });
    start += bucket.count;
  }
  return offsets;
}

/** The letter whose bucket contains the item at rowStartIndex, or null while
 * the offsets are unknown or the index runs past the last bucket. */
export function activeLetterForItem(
  itemIndex: number,
  offsets: LetterOffset[] | undefined
): string | null {
  if (!offsets || itemIndex < 0) return null;
  for (const bucket of offsets) {
    if (bucket.count > 0 && itemIndex >= bucket.start && itemIndex < bucket.start + bucket.count) {
      return bucket.letter;
    }
  }
  return null;
}

/**
 * The letter the TOP ROW belongs to, for rail highlighting. A row that isn't
 * column-aligned to a letter boundary mixes the previous letter's tail with
 * this letter's head; a jump always targets that row via floor(start /
 * columnCount), so the letter whose bucket STARTS somewhere in the row wins
 * (the row is "for" the letter it was jumped to), never the tail letter it
 * happens to open with. Falls back to plain containment for organic
 * scrolling between jumps, where no bucket starts inside the row at all.
 */
export function activeLetterForRow(
  topItem: number,
  columnCount: number,
  offsets: LetterOffset[] | undefined
): string | null {
  if (!offsets || topItem < 0 || columnCount <= 0) return null;
  const rowEnd = topItem + columnCount - 1;
  let claimed: LetterOffset | null = null;
  for (const bucket of offsets) {
    if (bucket.count === 0) continue;
    if (bucket.start >= topItem && bucket.start <= rowEnd) claimed = bucket;
  }
  return claimed?.letter ?? activeLetterForItem(topItem, offsets);
}

/** Page indices covering [firstItem, lastItem], clamped to the known total. */
export function pageIndicesForRange(
  firstItem: number,
  lastItem: number,
  totalItems: number | null
): number[] {
  const clampedFirst = Math.max(0, firstItem);
  const maxItem = totalItems !== null ? totalItems - 1 : lastItem;
  const clampedLast = Math.max(clampedFirst, Math.min(lastItem, maxItem));
  const firstPage = Math.floor(clampedFirst / CATALOG_PAGE_SIZE);
  const lastPage = Math.floor(clampedLast / CATALOG_PAGE_SIZE);
  const pages: number[] = [];
  for (let page = firstPage; page <= lastPage; page++) pages.push(page);
  return pages;
}

export function useShelves(
  serverIds: string[],
  timeRange: StatsTimeRange,
  includeDeadWeight: boolean = true
) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: ['media', 'shelves', sortedServerIds.join(','), timeRange, includeDeadWeight],
    queryFn: () =>
      api.library.shelves({ timeRange, serverIds: sortedServerIds, includeDeadWeight }),
    staleTime: 60_000,
    enabled: serverIds.length > 0,
  });
}

/** Browse's genre filter calls this without a range, so the range only joins the key when given. */
export function useGenres(type: LibraryMediaType, serverIds: string[], timeRange?: StatsTimeRange) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: [
      'media',
      'genres',
      type,
      sortedServerIds.join(','),
      ...(timeRange ? [timeRange, timeRange.timezone ?? browserTimeZone()] : []),
    ],
    queryFn: () => api.library.genres(type, sortedServerIds, timeRange),
    staleTime: 5 * 60_000,
  });
}

export function useGenreDetail(
  genre: string,
  type: LibraryMediaType,
  serverIds: string[],
  timeRange: StatsTimeRange,
  { enabled = true }: { enabled?: boolean } = {}
) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: [
      'media',
      'genres',
      'detail',
      genre,
      type,
      sortedServerIds.join(','),
      timeRange,
      timeRange.timezone ?? browserTimeZone(),
    ],
    queryFn: () => api.library.genreDetail(genre, type, sortedServerIds, timeRange),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useCatalogCodecs(type: LibraryMediaType, serverIds: string[]) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: ['media', 'codecs', type, sortedServerIds.join(',')],
    queryFn: () => api.library.catalogCodecs(type, sortedServerIds),
    staleTime: 5 * 60_000,
  });
}

export function useLibraries(serverIds: string[]) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: ['media', 'libraries', sortedServerIds.join(',')],
    queryFn: () => api.library.libraries(sortedServerIds),
    staleTime: 5 * 60_000,
  });
}

export interface MediaDetailStub {
  mediaId: string;
  title: string;
  year: number | null;
  posterUrl: string | null;
  posterVersion: string | null;
  dominantColor: string | null;
  servers: CatalogRowServerEntry[];
}

/**
 * The detail hook's data shape: the full detail response's fields are
 * optional (undefined while only the stub has painted), with the poster
 * fields required so a stub alone can paint them.
 */
export type MediaDetailData = Partial<MediaDetailResponse> & {
  posterUrl: string | null;
  posterVersion: string | null;
  dominantColor: string | null;
  servers: CatalogRowServerEntry[];
};

export function detailFromStub(stub: MediaDetailStub): MediaDetailData {
  return {
    id: stub.mediaId,
    title: stub.title,
    year: stub.year,
    posterUrl: stub.posterUrl,
    posterVersion: stub.posterVersion,
    dominantColor: stub.dominantColor,
    servers: stub.servers,
  };
}

export function useMediaDetail(
  id: string,
  serverIds: string[],
  lens: string,
  stub?: MediaDetailStub
) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: ['media', 'detail', id, sortedServerIds.join(','), lens],
    queryFn: async (): Promise<MediaDetailData> => {
      const detail = await api.library.media.detail(id, sortedServerIds);
      return { ...detail, servers: [] };
    },
    staleTime: 60_000,
    placeholderData: stub && (() => detailFromStub(stub)),
  });
}

/**
 * Looks up an already-cached catalog/shelf row for a media id so the detail
 * page's hero can paint a poster and dominant-color tint on the very first
 * render, before the detail response (which carries the same poster fields)
 * lands. A cache miss (e.g. a direct URL visit) simply yields no stub.
 */
export function findCachedMediaStub(
  queryClient: QueryClient,
  mediaId: string
): MediaDetailStub | undefined {
  function toStub(row: CatalogRow | ShelfRow): MediaDetailStub {
    return {
      mediaId: row.mediaId,
      title: row.title,
      year: row.year,
      posterUrl: row.posterUrl,
      posterVersion: row.posterVersion,
      dominantColor: row.dominantColor,
      servers: row.servers,
    };
  }

  // Catalog cache entries are one window (CatalogResponse) per page key; the
  // letters entries sharing the ['media', 'catalog'] prefix have no `data`
  // array and fall through the optional chain.
  const catalogQueries = queryClient.getQueriesData<CatalogResponse>({
    queryKey: ['media', 'catalog'],
  });
  for (const [, data] of catalogQueries) {
    const row = data?.data?.find((r) => r.mediaId === mediaId);
    if (row) return toStub(row);
  }

  const shelvesQueries = queryClient.getQueriesData<ShelvesResponse>({
    queryKey: ['media', 'shelves'],
  });
  for (const [, data] of shelvesQueries) {
    if (!data) continue;
    const row = [
      ...data.recentlyAddedMovies,
      ...data.recentlyAddedShows,
      ...data.mostPopularMovies,
      ...data.mostPopularShows,
      ...data.mostPlayedArtists,
      ...(data.deadWeight ?? []),
    ].find((r) => r.mediaId === mediaId);
    if (row) return toStub(row);
  }

  return undefined;
}

export function useMediaStats(id: string, serverIds: string[]) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: ['media', 'stats', id, sortedServerIds.join(',')],
    queryFn: () => api.library.media.stats(id, sortedServerIds),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
  });
}

export function useMediaWatchers(
  id: string,
  serverIds: string[],
  window: 'all_time' | 'last_30' | 'last_7' = 'all_time'
) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: ['media', 'watchers', id, sortedServerIds.join(','), window],
    queryFn: () => api.library.media.watchers(id, window, sortedServerIds),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
  });
}

export function useSeasonHeat(id: string, serverIds: string[], enabled = true) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: ['media', 'season-heat', id, sortedServerIds.join(',')],
    queryFn: (): Promise<MediaSeasonHeatResponse> =>
      api.library.media.seasonHeat(id, sortedServerIds),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    enabled,
  });
}

export function useMediaChildren(id: string, serverIds: string[], enabled = true) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: ['media', 'children', id, sortedServerIds.join(',')],
    queryFn: () => api.library.media.children(id, sortedServerIds),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
    enabled,
  });
}

export function useMediaPlatforms(id: string, serverIds: string[]) {
  const sortedServerIds = [...serverIds].sort();
  return useQuery({
    queryKey: ['media', 'platforms', id, sortedServerIds.join(',')],
    queryFn: () => api.library.media.platforms(id, sortedServerIds),
    staleTime: 60_000,
    gcTime: 10 * 60_000,
  });
}

const HISTORY_PAGE_SIZE = 50;

export function useMediaHistory(id: string, serverIds: string[]) {
  const sortedServerIds = [...serverIds].sort();
  return useInfiniteQuery({
    queryKey: ['media', 'history', id, sortedServerIds.join(',')],
    queryFn: ({ pageParam }): Promise<MediaHistoryPageResponse> =>
      api.library.media.history(id, pageParam, HISTORY_PAGE_SIZE, sortedServerIds),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.meta.nextCursor ?? undefined,
    staleTime: 60_000,
    gcTime: 10 * 60_000,
  });
}
