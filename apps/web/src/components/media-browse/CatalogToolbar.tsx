import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Search, SlidersHorizontal, X } from 'lucide-react';
import type { GenreRow, LibraryOption, WatchedState } from '@tracearr/shared';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetFooter,
  SheetTrigger,
} from '@/components/ui/sheet';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MediaTypeToggle } from '@/components/media-browse/MediaTypeToggle';
import { stableSerialize, type CatalogSort } from '@/hooks/queries';
import { useIsMobile } from '@/hooks/use-mobile';
import { formatBytes } from '@/lib/formatters';
import { cn } from '@/lib/utils';

export type { CatalogSort };

export interface PersistedGridFilters {
  resolution?: string;
  genre?: string;
  yearFrom?: number;
  yearTo?: number;
  watched?: WatchedState;
  serverId?: string;
  /** `${serverId}:${libraryId}` - a library id is only unique within its server. */
  libraryKey?: string;
  hdr?: boolean;
  sizeGbMin?: number;
  sizeGbMax?: number;
  sort: CatalogSort;
}

export const DEFAULT_GRID_FILTERS: PersistedGridFilters = { sort: 'title' };
export const RESOLUTION_OPTIONS = ['4K', '1080p', '720p', 'SD'] as const;
const SORT_OPTIONS: CatalogSort[] = ['title', 'added', 'year', 'plays', 'watch_time', 'viewers'];
const WATCHED_OPTIONS: WatchedState[] = ['unwatched', 'partial', 'watched'];

/** Server-reported library mediaType tokens, lowercased: Plex uses the
 * singular ('movie'/'show'), Jellyfin/Emby use CollectionType ('movies'/
 * 'tvshows'). Anything outside these sets (music, photos, mixed, ...) is a
 * definitively different content type, not "untyped". */
const MOVIE_LIBRARY_TYPES = new Set(['movie', 'movies']);
const SHOW_LIBRARY_TYPES = new Set(['show', 'shows', 'tvshows', 'tv']);

/** Libraries offered for one grid type: its own type plus untyped/unknown
 * libraries, so a library synced before mediaType existed still shows up. A
 * library classified as the other content type (or a non-video type like
 * music/photos) never appears in either grid's list. */
export function librariesForGridType(
  libraries: LibraryOption[],
  type: 'movie' | 'show'
): LibraryOption[] {
  const matchSet = type === 'movie' ? MOVIE_LIBRARY_TYPES : SHOW_LIBRARY_TYPES;
  return libraries.filter((lib) => {
    const mediaType = lib.mediaType.toLowerCase().trim();
    if (!mediaType || mediaType === 'unknown') return true;
    return matchSet.has(mediaType);
  });
}

export function libraryKeyFor(library: Pick<LibraryOption, 'serverId' | 'libraryId'>): string {
  return `${library.serverId}:${library.libraryId}`;
}

function storageKey(type: 'movie' | 'show'): string {
  return `tracearr_media_filters_${type}`;
}

export function loadPersistedFilters(type: 'movie' | 'show'): PersistedGridFilters {
  try {
    const raw = localStorage.getItem(storageKey(type));
    if (!raw) return { ...DEFAULT_GRID_FILTERS };
    const parsed = JSON.parse(raw) as Partial<PersistedGridFilters>;
    return { ...DEFAULT_GRID_FILTERS, ...parsed };
  } catch {
    return { ...DEFAULT_GRID_FILTERS };
  }
}

export function persistFilters(type: 'movie' | 'show', filters: PersistedGridFilters): void {
  try {
    localStorage.setItem(storageKey(type), stableSerialize(filters));
  } catch {
    /* private browsing / storage full - filters just won't survive this reload */
  }
}

export interface FilterValidationContext {
  serverIds: string[];
  /** undefined = genre list hasn't loaded yet; skip validation rather than false-drop it. */
  genres: string[] | undefined;
  /** undefined = library list hasn't loaded yet; skip validation rather than false-drop it. */
  libraryKeys: string[] | undefined;
}

/**
 * Drops a persisted filter value that no longer resolves - a server removed
 * from the account, a genre absent from the current scope, or a library that
 * disappeared from the fetched list - so a stale localStorage blob can never
 * silently keep requesting a scope the viewer can no longer see.
 */
export function validatePersistedFilters(
  filters: PersistedGridFilters,
  context: FilterValidationContext
): PersistedGridFilters {
  const next = { ...filters };
  if (next.serverId && !context.serverIds.includes(next.serverId)) {
    delete next.serverId;
  }
  if (next.genre && context.genres && !context.genres.includes(next.genre)) {
    delete next.genre;
  }
  if (next.libraryKey && context.libraryKeys && !context.libraryKeys.includes(next.libraryKey)) {
    delete next.libraryKey;
  }
  if (next.libraryKey && next.serverId && !next.libraryKey.startsWith(`${next.serverId}:`)) {
    delete next.libraryKey;
  }
  return next;
}

const ALL_SENTINEL = '__all__';

// Mirrors the server's CATALOG_SIZE_GB_MAX schema bound; values past it 400.
const SIZE_GB_MAX = 10000;

function parseSizeGbInput(raw: string): number | undefined {
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return undefined;
  return Math.min(value, SIZE_GB_MAX);
}

interface FilterChipProps {
  label: string;
  removeLabel: string;
  onRemove: () => void;
}

function FilterChip({ label, removeLabel, onRemove }: FilterChipProps) {
  return (
    <span className="border-primary/40 bg-primary/10 text-primary inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium">
      {label}
      <button
        type="button"
        onClick={onRemove}
        className="opacity-70 hover:opacity-100"
        aria-label={removeLabel}
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}

interface CatalogToolbarProps {
  type: 'movie' | 'show';
  onTypeChange: (type: 'movie' | 'show') => void;
  search: string;
  onSearchChange: (search: string) => void;
  filters: PersistedGridFilters;
  onFiltersChange: (next: PersistedGridFilters) => void;
  genres: GenreRow[];
  servers: { id: string; name: string }[];
  libraries: LibraryOption[];
  totalItems: number | undefined;
  totalFileSize: number | undefined;
  /** The letter-scrubber Select, rendered inside the mobile filter Sheet only. */
  mobileScrubber?: ReactNode;
  className?: string;
}

export function CatalogToolbar({
  type,
  onTypeChange,
  search,
  onSearchChange,
  filters,
  onFiltersChange,
  genres,
  servers,
  libraries,
  totalItems,
  totalFileSize,
  mobileScrubber,
  className,
}: CatalogToolbarProps) {
  const { t } = useTranslation('pages');
  const isMobile = useIsMobile();
  const [searchInput, setSearchInput] = useState(search);
  const [sheetOpen, setSheetOpen] = useState(false);

  // Debounced commits below merge onto this instead of the `filters` closure
  // captured when their timer was scheduled, so a filter change elsewhere
  // (HDR, genre, ...) landing inside the debounce window survives instead of
  // getting overwritten by a stale spread.
  const filtersRef = useRef(filters);
  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      if (searchInput !== search) onSearchChange(searchInput);
    }, 300);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on searchInput edits, not every onSearchChange identity change
  }, [searchInput]);

  // Year bounds debounce like search: typing "2015" must not fire a catalog
  // request per keystroke (yearFrom=2 is also a nonsense scope).
  const [yearFromInput, setYearFromInput] = useState(filters.yearFrom?.toString() ?? '');
  const [yearToInput, setYearToInput] = useState(filters.yearTo?.toString() ?? '');

  useEffect(() => {
    setYearFromInput(filters.yearFrom?.toString() ?? '');
  }, [filters.yearFrom]);

  useEffect(() => {
    setYearToInput(filters.yearTo?.toString() ?? '');
  }, [filters.yearTo]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      const yearFrom = yearFromInput ? Number(yearFromInput) : undefined;
      const yearTo = yearToInput ? Number(yearToInput) : undefined;
      const current = filtersRef.current;
      if (yearFrom !== current.yearFrom || yearTo !== current.yearTo) {
        onFiltersChange({ ...current, yearFrom, yearTo });
      }
    }, 400);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on input edits, not filter/handler identity changes
  }, [yearFromInput, yearToInput]);

  // Size-on-disk bounds debounce, same shape as the year inputs.
  const [sizeGbMinInput, setSizeGbMinInput] = useState(filters.sizeGbMin?.toString() ?? '');
  const [sizeGbMaxInput, setSizeGbMaxInput] = useState(filters.sizeGbMax?.toString() ?? '');

  useEffect(() => {
    setSizeGbMinInput(filters.sizeGbMin?.toString() ?? '');
  }, [filters.sizeGbMin]);

  useEffect(() => {
    setSizeGbMaxInput(filters.sizeGbMax?.toString() ?? '');
  }, [filters.sizeGbMax]);

  useEffect(() => {
    const timeout = setTimeout(() => {
      let sizeGbMin = parseSizeGbInput(sizeGbMinInput);
      let sizeGbMax = parseSizeGbInput(sizeGbMaxInput);
      if (sizeGbMin !== undefined && sizeGbMax !== undefined && sizeGbMin > sizeGbMax) {
        [sizeGbMin, sizeGbMax] = [sizeGbMax, sizeGbMin];
      }
      const current = filtersRef.current;
      if (sizeGbMin !== current.sizeGbMin || sizeGbMax !== current.sizeGbMax) {
        onFiltersChange({ ...current, sizeGbMin, sizeGbMax });
      }
    }, 400);
    return () => clearTimeout(timeout);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fire only on input edits, not filter/handler identity changes
  }, [sizeGbMinInput, sizeGbMaxInput]);

  const watchedLabel = useCallback(
    (state: WatchedState | undefined) => {
      if (!state) return t('media.grid.toolbar.watched.all');
      return t(`media.grid.toolbar.watched.${state}`);
    },
    [t]
  );

  const gridLibraries = useMemo(() => librariesForGridType(libraries, type), [libraries, type]);
  const selectableLibraries = useMemo(
    () =>
      filters.serverId
        ? gridLibraries.filter((lib) => lib.serverId === filters.serverId)
        : gridLibraries,
    [gridLibraries, filters.serverId]
  );
  const librariesByServer = useMemo(() => {
    const map = new Map<string, LibraryOption[]>();
    for (const lib of selectableLibraries) {
      const list = map.get(lib.serverId) ?? [];
      list.push(lib);
      map.set(lib.serverId, list);
    }
    return map;
  }, [selectableLibraries]);
  const showLibraryGroups = librariesByServer.size > 1;
  const selectedLibrary = gridLibraries.find((lib) => libraryKeyFor(lib) === filters.libraryKey);

  const activeFilterCount = [
    filters.watched,
    filters.resolution,
    filters.genre,
    filters.yearFrom,
    filters.yearTo,
    filters.serverId,
    filters.libraryKey,
    filters.hdr,
    filters.sizeGbMin,
    filters.sizeGbMax,
  ].filter((v) => v !== undefined).length;

  const chips = useMemo(() => {
    const list: { key: string; label: string; onRemove: () => void }[] = [];
    if (filters.watched) {
      list.push({
        key: 'watched',
        label: watchedLabel(filters.watched),
        onRemove: () => onFiltersChange({ ...filters, watched: undefined }),
      });
    }
    if (filters.resolution) {
      list.push({
        key: 'resolution',
        label: filters.resolution,
        onRemove: () => onFiltersChange({ ...filters, resolution: undefined }),
      });
    }
    if (filters.genre) {
      list.push({
        key: 'genre',
        label: filters.genre,
        onRemove: () => onFiltersChange({ ...filters, genre: undefined }),
      });
    }
    if (filters.yearFrom !== undefined || filters.yearTo !== undefined) {
      const label =
        filters.yearFrom !== undefined && filters.yearTo !== undefined
          ? `${filters.yearFrom}–${filters.yearTo}`
          : (filters.yearFrom ?? filters.yearTo)?.toString();
      list.push({
        key: 'year',
        label: label ?? '',
        onRemove: () => onFiltersChange({ ...filters, yearFrom: undefined, yearTo: undefined }),
      });
    }
    if (filters.serverId) {
      const server = servers.find((s) => s.id === filters.serverId);
      list.push({
        key: 'server',
        label: server?.name ?? filters.serverId,
        onRemove: () => onFiltersChange({ ...filters, serverId: undefined }),
      });
    }
    if (filters.libraryKey) {
      const label = selectedLibrary
        ? `${selectedLibrary.serverName} - ${selectedLibrary.name}`
        : filters.libraryKey;
      list.push({
        key: 'library',
        label,
        onRemove: () => onFiltersChange({ ...filters, libraryKey: undefined }),
      });
    }
    if (filters.hdr) {
      list.push({
        key: 'hdr',
        label: t('media.grid.toolbar.hdrChip'),
        onRemove: () => onFiltersChange({ ...filters, hdr: undefined }),
      });
    }
    if (filters.sizeGbMin !== undefined || filters.sizeGbMax !== undefined) {
      const label =
        filters.sizeGbMin !== undefined && filters.sizeGbMax !== undefined
          ? t('media.grid.toolbar.sizeChipRange', {
              min: filters.sizeGbMin,
              max: filters.sizeGbMax,
            })
          : filters.sizeGbMin !== undefined
            ? t('media.grid.toolbar.sizeChipAtLeast', { min: filters.sizeGbMin })
            : t('media.grid.toolbar.sizeChipAtMost', { max: filters.sizeGbMax });
      list.push({
        key: 'size',
        label,
        onRemove: () => onFiltersChange({ ...filters, sizeGbMin: undefined, sizeGbMax: undefined }),
      });
    }
    return list;
  }, [filters, servers, selectedLibrary, t, watchedLabel, onFiltersChange]);

  const countLine =
    totalItems !== undefined && totalFileSize !== undefined
      ? t('media.grid.toolbar.countTotal', {
          count: totalItems,
          size: formatBytes(totalFileSize, 1, { minUnit: 'GB' }),
        })
      : undefined;

  const filterFields = (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <span className="text-muted-foreground block text-xs">
          {t('media.grid.toolbar.watchedLabel')}
        </span>
        <Select
          value={filters.watched ?? ALL_SENTINEL}
          onValueChange={(value) =>
            onFiltersChange({
              ...filters,
              watched: value === ALL_SENTINEL ? undefined : (value as WatchedState),
            })
          }
        >
          <SelectTrigger aria-label={t('media.grid.toolbar.watchedLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SENTINEL}>{t('media.grid.toolbar.watched.all')}</SelectItem>
            {WATCHED_OPTIONS.map((state) => (
              <SelectItem key={state} value={state}>
                {watchedLabel(state)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <span className="text-muted-foreground block text-xs">
          {t('media.grid.toolbar.resolutionLabel')}
        </span>
        <Select
          value={filters.resolution ?? ALL_SENTINEL}
          onValueChange={(value) =>
            onFiltersChange({
              ...filters,
              resolution: value === ALL_SENTINEL ? undefined : value,
            })
          }
        >
          <SelectTrigger aria-label={t('media.grid.toolbar.resolutionLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SENTINEL}>{t('media.grid.toolbar.resolutionAll')}</SelectItem>
            {RESOLUTION_OPTIONS.map((resolution) => (
              <SelectItem key={resolution} value={resolution}>
                {resolution}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <span className="text-muted-foreground block text-xs">
          {t('media.grid.toolbar.hdrLabel')}
        </span>
        <Select
          value={filters.hdr ? 'hdr' : ALL_SENTINEL}
          onValueChange={(value) =>
            onFiltersChange({ ...filters, hdr: value === 'hdr' ? true : undefined })
          }
        >
          <SelectTrigger aria-label={t('media.grid.toolbar.hdrLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SENTINEL}>{t('media.grid.toolbar.hdrAll')}</SelectItem>
            <SelectItem value="hdr">{t('media.grid.toolbar.hdrOnly')}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-1.5">
        <span className="text-muted-foreground block text-xs">
          {t('media.grid.toolbar.genreLabel')}
        </span>
        <Select
          value={filters.genre ?? ALL_SENTINEL}
          onValueChange={(value) =>
            onFiltersChange({ ...filters, genre: value === ALL_SENTINEL ? undefined : value })
          }
        >
          <SelectTrigger aria-label={t('media.grid.toolbar.genreLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SENTINEL}>{t('media.grid.toolbar.genreAll')}</SelectItem>
            {genres.map((genre) => (
              <SelectItem key={genre.genre} value={genre.genre}>
                {genre.genre} ({genre.itemCount})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <span className="text-muted-foreground block text-xs">
            {t('media.grid.toolbar.yearFromLabel')}
          </span>
          <Input
            type="number"
            inputMode="numeric"
            aria-label={t('media.grid.toolbar.yearFromLabel')}
            value={yearFromInput}
            onChange={(e) => setYearFromInput(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <span className="text-muted-foreground block text-xs">
            {t('media.grid.toolbar.yearToLabel')}
          </span>
          <Input
            type="number"
            inputMode="numeric"
            aria-label={t('media.grid.toolbar.yearToLabel')}
            value={yearToInput}
            onChange={(e) => setYearToInput(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="text-muted-foreground block text-xs">
          {t('media.grid.toolbar.serverLabel')}
        </span>
        <Select
          value={filters.serverId ?? ALL_SENTINEL}
          onValueChange={(value) => {
            const serverId = value === ALL_SENTINEL ? undefined : value;
            const libraryKey =
              filters.libraryKey && serverId && !filters.libraryKey.startsWith(`${serverId}:`)
                ? undefined
                : filters.libraryKey;
            onFiltersChange({ ...filters, serverId, libraryKey });
          }}
        >
          <SelectTrigger aria-label={t('media.grid.toolbar.serverLabel')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_SENTINEL}>{t('media.grid.toolbar.serverAll')}</SelectItem>
            {servers.map((server) => (
              <SelectItem key={server.id} value={server.id}>
                {server.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {selectableLibraries.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-muted-foreground block text-xs">
            {t('media.grid.toolbar.libraryLabel')}
          </span>
          <Select
            value={filters.libraryKey ?? ALL_SENTINEL}
            onValueChange={(value) =>
              onFiltersChange({
                ...filters,
                libraryKey: value === ALL_SENTINEL ? undefined : value,
              })
            }
          >
            <SelectTrigger aria-label={t('media.grid.toolbar.libraryLabel')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_SENTINEL}>{t('media.grid.toolbar.libraryAll')}</SelectItem>
              {showLibraryGroups
                ? [...librariesByServer.entries()].map(([serverId, libs]) => (
                    <SelectGroup key={serverId}>
                      <SelectLabel>{libs[0]?.serverName}</SelectLabel>
                      {libs.map((lib) => (
                        <SelectItem key={libraryKeyFor(lib)} value={libraryKeyFor(lib)}>
                          {lib.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))
                : selectableLibraries.map((lib) => (
                    <SelectItem key={libraryKeyFor(lib)} value={libraryKeyFor(lib)}>
                      {lib.name}
                    </SelectItem>
                  ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <span className="text-muted-foreground block text-xs">
            {t('media.grid.toolbar.sizeGbMinLabel')}
          </span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={SIZE_GB_MAX}
            aria-label={t('media.grid.toolbar.sizeGbMinLabel')}
            value={sizeGbMinInput}
            onChange={(e) => setSizeGbMinInput(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <span className="text-muted-foreground block text-xs">
            {t('media.grid.toolbar.sizeGbMaxLabel')}
          </span>
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={SIZE_GB_MAX}
            aria-label={t('media.grid.toolbar.sizeGbMaxLabel')}
            value={sizeGbMaxInput}
            onChange={(e) => setSizeGbMaxInput(e.target.value)}
          />
        </div>
      </div>

      {mobileScrubber && isMobile && (
        <div className="space-y-1.5">
          <span className="text-muted-foreground block text-xs">
            {t('media.grid.scrubber.label')}
          </span>
          {mobileScrubber}
        </div>
      )}
    </div>
  );

  const filterTrigger = (
    <Button variant="outline" size="sm" className="h-9 gap-1.5">
      <SlidersHorizontal className="h-3.5 w-3.5" />
      {t('media.grid.toolbar.filtersLabel')}
      {activeFilterCount > 0 && (
        <Badge variant="secondary" className="ml-1 h-5 px-1.5 text-[10px]">
          {activeFilterCount}
        </Badge>
      )}
    </Button>
  );

  return (
    <div
      className={cn(
        'bg-background/92 sticky top-0 z-30 space-y-3 border-b py-3 backdrop-blur',
        className
      )}
      aria-label={t('media.grid.toolbar.ariaLabel')}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <MediaTypeToggle value={type} onChange={onTypeChange} />

        <div className="relative max-w-[240px] min-w-[160px] flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder={t('media.grid.toolbar.searchPlaceholder')}
            aria-label={t('media.grid.toolbar.searchLabel')}
            className="h-9 pl-8"
          />
        </div>

        {isMobile ? (
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetTrigger asChild>{filterTrigger}</SheetTrigger>
            <SheetContent side="right" className="overflow-y-auto">
              <SheetHeader>
                <SheetTitle>{t('media.grid.toolbar.filtersSheetTitle')}</SheetTitle>
              </SheetHeader>
              <div className="px-4">{filterFields}</div>
              <SheetFooter>
                <Button variant="ghost" onClick={() => setSheetOpen(false)}>
                  {t('media.grid.toolbar.done')}
                </Button>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        ) : (
          <Popover>
            <PopoverTrigger asChild>{filterTrigger}</PopoverTrigger>
            <PopoverContent
              align="start"
              className="max-h-[var(--radix-popover-content-available-height)] w-72 overflow-y-auto"
            >
              {filterFields}
            </PopoverContent>
          </Popover>
        )}

        <div className="space-y-1.5">
          <Select
            value={filters.sort}
            onValueChange={(value) => onFiltersChange({ ...filters, sort: value as CatalogSort })}
          >
            <SelectTrigger
              aria-label={t('media.grid.toolbar.sortLabel')}
              className="h-9 w-auto min-w-[150px]"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORT_OPTIONS.map((sort) => (
                <SelectItem key={sort} value={sort}>
                  {t(`media.grid.toolbar.sort.${sort}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {countLine && (
          <span className="text-muted-foreground ml-auto text-xs tabular-nums">{countLine}</span>
        )}
      </div>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <FilterChip
              key={chip.key}
              label={chip.label}
              removeLabel={t('media.grid.toolbar.removeFilter', { label: chip.label })}
              onRemove={chip.onRemove}
            />
          ))}
        </div>
      )}
    </div>
  );
}
