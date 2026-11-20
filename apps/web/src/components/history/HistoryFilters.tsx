/**
 * Clean filter bar for the History page using shadcn dropdown pattern.
 * Features TimeRangePicker, search, filter dropdown, and column visibility toggle.
 */

import { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Film,
  Tv,
  Music,
  Radio,
  Clapperboard,
  MonitorPlay,
  Subtitles,
  Zap,
  X,
  Search,
  ListFilter,
  User,
  UserRound,
  Globe,
  MapPin,
  Wifi,
  Monitor,
  ChevronDown,
  Columns3,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { TimeRangePicker, type TimeRangeValue } from '@/components/ui/time-range-picker';
import { ScrollArea } from '@/components/ui/scroll-area';
import { showsProfiles, useProfileOptionLabel } from '@/components/sessions/useProfileLabel';
import type { HistoryFilters } from '@/hooks/queries/useHistory';
import { PLAYBACK_DECISION_ICONS } from '@/lib/playbackBadge';
import {
  PLAYBACK_DECISIONS,
  PLAYBACK_DECISION_LABEL_KEYS,
  type HistoryFilterOptions,
  type ProfileFilterOption,
} from '@tracearr/shared';
import { HISTORY_COLUMNS, type ColumnVisibility, type HistoryColumnId } from './historyColumns';

interface Props {
  filters: HistoryFilters;
  onFiltersChange: (filters: HistoryFilters) => void;
  timeRange: TimeRangeValue;
  onTimeRangeChange: (timeRange: TimeRangeValue) => void;
  filterOptions?: HistoryFilterOptions;
  isFetching?: boolean;
  columnVisibility: ColumnVisibility;
  onColumnToggle: (column: HistoryColumnId, shown: boolean) => void;
  isMultiServer?: boolean;
  /** Every row is the member's own, so there is no one to filter by. */
  isMember?: boolean;
}

function toggleList<T>(current: T[] | undefined, values: T[], checked: boolean): T[] | undefined {
  const updated = checked
    ? [...new Set([...(current ?? []), ...values])]
    : (current ?? []).filter((value) => !values.includes(value));
  return updated.length > 0 ? updated : undefined;
}

// Filter chip component
function FilterChip({
  label,
  value,
  icon: Icon,
  onRemove,
}: {
  label: string;
  value: string;
  icon?: typeof User;
  onRemove: () => void;
}) {
  return (
    <Badge variant="secondary" className="h-7 gap-1.5 pr-1.5 pl-2.5 text-xs font-normal">
      {Icon && <Icon className="text-muted-foreground h-3 w-3" />}
      <span className="text-muted-foreground">{label}:</span>
      <span className="max-w-[120px] truncate font-medium">{value}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
        className="hover:bg-muted-foreground/20 ml-0.5 rounded-full p-0.5"
      >
        <X className="h-3 w-3" />
      </button>
    </Badge>
  );
}

export function HistoryFiltersBar({
  filters,
  onFiltersChange,
  timeRange,
  onTimeRangeChange,
  filterOptions,
  isFetching,
  columnVisibility,
  onColumnToggle,
  isMultiServer = false,
  isMember = false,
}: Props) {
  const { t } = useTranslation(['common', 'pages', 'nav']);
  const profileOptionLabel = useProfileOptionLabel();
  const [searchInput, setSearchInput] = useState(filters.search ?? '');

  // Sync search input with filters
  useEffect(() => {
    setSearchInput(filters.search ?? '');
  }, [filters.search]);

  const mediaTypeOptions = useMemo(
    () => [
      { value: 'movie' as const, label: t('common:media.movie_plural'), icon: Film },
      { value: 'episode' as const, label: t('common:media.tvShows'), icon: Tv },
      { value: 'track' as const, label: t('common:media.music'), icon: Music },
      { value: 'live' as const, label: t('common:media.liveTV'), icon: Radio },
      { value: 'trailer' as const, label: t('pages:history.filters.trailers'), icon: Clapperboard },
    ],
    [t]
  );
  const mediaTypeLabels = useMemo(
    () => Object.fromEntries(mediaTypeOptions.map((o) => [o.value, o.label])),
    [mediaTypeOptions]
  );

  const activeFilters = useMemo(() => {
    const active: {
      key: keyof HistoryFilters;
      label: string;
      value: string;
      icon?: typeof User;
    }[] = [];
    const listSummary = (labels: string[]) =>
      labels.length > 2
        ? t('pages:history.filters.selected', { count: labels.length })
        : labels.join(', ');

    if (filters.serverUserIds?.length) {
      // Match by any of the person's account ids, not just the representative id,
      // so a merged person's chip shows one name instead of "Unknown".
      const matchedUsers =
        filterOptions?.users?.filter((u) =>
          (u.serverUserIds ?? [u.id]).some((id) => filters.serverUserIds?.includes(id))
        ) ?? [];
      const userNames = matchedUsers.map(
        (u) => u.identityName || u.username || t('common:labels.unknown')
      );
      active.push({
        key: 'serverUserIds',
        label: t('nav:users'),
        value: listSummary(userNames),
        icon: User,
      });
    }
    if (filters.profileIds?.length) {
      const profileNames =
        filterOptions?.profiles
          .filter((profile) => filters.profileIds?.includes(profile.id))
          .map(profileOptionLabel) ?? [];
      active.push({
        key: 'profileIds',
        label: t('common:labels.profiles'),
        value: listSummary(profileNames),
        icon: UserRound,
      });
    }
    if (filters.platforms?.length) {
      active.push({
        key: 'platforms',
        label: t('pages:activity.platforms'),
        value: listSummary(filters.platforms),
        icon: Monitor,
      });
    }
    if (filters.geoCountries?.length) {
      active.push({
        key: 'geoCountries',
        label: t('pages:history.filters.countries'),
        value: listSummary(filters.geoCountries),
        icon: Globe,
      });
    }
    const unknown = t('common:labels.unknown');
    if (filters.geoCity || filters.geoCityMissing) {
      active.push({
        key: filters.geoCity ? 'geoCity' : 'geoCityMissing',
        label: t('pages:history.location.city'),
        value: filters.geoCity || unknown,
        icon: MapPin,
      });
    }
    if (filters.geoRegion || filters.geoRegionMissing) {
      active.push({
        key: filters.geoRegion ? 'geoRegion' : 'geoRegionMissing',
        label: t('pages:history.location.region'),
        value: filters.geoRegion || unknown,
        icon: MapPin,
      });
    }
    if (filters.mediaTypes?.length) {
      const typeLabels = filters.mediaTypes.map((type) => mediaTypeLabels[type] ?? type);
      active.push({
        key: 'mediaTypes',
        label: t('pages:history.filters.types'),
        value: listSummary(typeLabels),
        icon: Film,
      });
    }
    if (filters.transcodeDecisions?.length) {
      const decisionLabels = filters.transcodeDecisions.map((d) =>
        t(PLAYBACK_DECISION_LABEL_KEYS[d])
      );
      active.push({
        key: 'transcodeDecisions',
        label: t('common:labels.quality'),
        value: listSummary(decisionLabels),
        icon: filters.transcodeDecisions.includes('transcode') ? Zap : MonitorPlay,
      });
    }
    if (filters.subtitleBurnIn) {
      active.push({
        key: 'subtitleBurnIn',
        label: t('common:labels.quality'),
        value: t('playback.burnIn'),
        icon: Subtitles,
      });
    }
    if (filters.network) {
      active.push({
        key: 'network',
        label: t('pages:history.filters.network'),
        value:
          filters.network === 'local'
            ? t('common:labels.local')
            : t('pages:history.filters.remote'),
        icon: filters.network === 'local' ? Wifi : Globe,
      });
    }

    return active;
  }, [
    filters,
    filterOptions?.users,
    filterOptions?.profiles,
    profileOptionLabel,
    mediaTypeLabels,
    t,
  ]);

  // Debounced search effect
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      if (searchInput !== (filters.search ?? '')) {
        onFiltersChange({ ...filters, search: searchInput || undefined });
      }
    }, 300);
    return () => clearTimeout(timeoutId);
  }, [searchInput, filters, onFiltersChange]);

  // Remove a specific filter
  const removeFilter = useCallback(
    (key: keyof HistoryFilters) => {
      const { [key]: _, ...newFilters } = filters;
      if (key === 'search') setSearchInput('');
      onFiltersChange(newFilters);
    },
    [filters, onFiltersChange]
  );

  // Clear all filters
  const clearFilters = useCallback(() => {
    setSearchInput('');
    onFiltersChange({});
  }, [onFiltersChange]);

  const hasActiveFilters = activeFilters.length > 0 || filters.search;
  const activeFilterCount = activeFilters.length + (filters.search ? 1 : 0);
  const menuColumns = HISTORY_COLUMNS.filter(
    (column) => (column.id !== 'server' || isMultiServer) && (column.id !== 'user' || !isMember)
  );
  const shownColumnCount = menuColumns.filter((column) => columnVisibility[column.id]).length;

  // Sort users alphabetically (case-insensitive)
  const sortedUsers = useMemo(() => {
    if (!filterOptions?.users) return [];
    return [...filterOptions.users].sort((a, b) => {
      const nameA = (a.identityName || a.username || '').toLowerCase();
      const nameB = (b.identityName || b.username || '').toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }, [filterOptions?.users]);

  const profileGroups = useMemo(() => {
    const groups = new Map<
      string,
      { serverUserId: string; account: string; server: string; profiles: ProfileFilterOption[] }
    >();
    for (const profile of filterOptions?.profiles ?? []) {
      const group = groups.get(profile.serverUserId);
      if (group) {
        group.profiles.push(profile);
      } else {
        groups.set(profile.serverUserId, {
          serverUserId: profile.serverUserId,
          account: profile.accountUsername,
          server: profile.serverName,
          profiles: [profile],
        });
      }
    }
    return [...groups.values()]
      .filter((group) => showsProfiles(group.profiles))
      .sort((a, b) => a.account.localeCompare(b.account) || a.server.localeCompare(b.server));
  }, [filterOptions?.profiles]);
  const profileServersDiffer = new Set(profileGroups.map((group) => group.server)).size > 1;

  return (
    <div className="space-y-3">
      {/* Row 1: Time range, search, filter dropdown, and columns dropdown */}
      <div className="flex flex-wrap items-center gap-3">
        <TimeRangePicker value={timeRange} onChange={onTimeRangeChange} />

        <div className="relative max-w-[400px] min-w-[200px] flex-1">
          <Search className="text-muted-foreground absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2" />
          <Input
            placeholder={t('pages:history.searchPlaceholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-8 pr-8 pl-8 text-sm"
          />
          {searchInput && (
            <button
              onClick={() => {
                setSearchInput('');
                onFiltersChange({ ...filters, search: undefined });
              }}
              className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        {/* Filter dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <ListFilter className="h-4 w-4" />
              {t('common:labels.filters')}
              {activeFilterCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                  {activeFilterCount}
                </Badge>
              )}
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            {/* User filter - multi-select */}
            {!isMember && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <User className="mr-2 h-4 w-4" />
                  {t('nav:users')}
                  {filters.serverUserIds?.length ? (
                    <Badge variant="secondary" className="ml-auto h-5 px-1.5">
                      {filters.serverUserIds.length}
                    </Badge>
                  ) : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="p-0">
                  <ScrollArea className="h-[250px]">
                    <div className="p-1">
                      {filters.serverUserIds?.length ? (
                        <>
                          <DropdownMenuItem onClick={() => removeFilter('serverUserIds')}>
                            <X />
                            {t('pages:history.filters.clearUsers')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      ) : null}
                      {sortedUsers.map((user) => {
                        // A person may have multiple server accounts (merged identity);
                        // select/deselect all of them together so their full history shows.
                        const personIds = user.serverUserIds ?? [user.id];
                        const isSelected = personIds.some(
                          (id) => filters.serverUserIds?.includes(id) ?? false
                        );
                        return (
                          <DropdownMenuCheckboxItem
                            key={user.id}
                            checked={isSelected}
                            onCheckedChange={(checked) =>
                              onFiltersChange({
                                ...filters,
                                serverUserIds: toggleList(
                                  filters.serverUserIds,
                                  personIds,
                                  checked
                                ),
                              })
                            }
                            onSelect={(e) => e.preventDefault()}
                          >
                            <Avatar className="mr-2 h-5 w-5">
                              <AvatarImage src={user.thumbUrl ?? undefined} />
                              <AvatarFallback className="text-xs">
                                {user.username?.[0]?.toUpperCase() ?? '?'}
                              </AvatarFallback>
                            </Avatar>
                            <span className="truncate">{user.identityName || user.username}</span>
                          </DropdownMenuCheckboxItem>
                        );
                      })}
                    </div>
                  </ScrollArea>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            {/* Profile filter - multi-select, for accounts with a profile besides their main one */}
            {!isMember && profileGroups.length > 0 && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <UserRound className="mr-2 h-4 w-4" />
                  {t('common:labels.profiles')}
                  {filters.profileIds?.length ? (
                    <Badge variant="secondary" className="ml-auto h-5 px-1.5">
                      {filters.profileIds.length}
                    </Badge>
                  ) : null}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="p-0">
                  <ScrollArea className="[&>[data-slot=scroll-area-viewport]]:max-h-[250px]">
                    <div className="p-1">
                      {filters.profileIds?.length ? (
                        <>
                          <DropdownMenuItem onClick={() => removeFilter('profileIds')}>
                            <X />
                            {t('pages:history.filters.clearProfiles')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                        </>
                      ) : null}
                      {profileGroups.map(({ serverUserId, account, server, profiles }) => (
                        <DropdownMenuGroup key={serverUserId} aria-label={account}>
                          {profileGroups.length > 1 && (
                            <DropdownMenuLabel className="text-muted-foreground flex justify-between gap-2 text-xs">
                              <span className="truncate">{account}</span>
                              {profileServersDiffer && <span className="shrink-0">{server}</span>}
                            </DropdownMenuLabel>
                          )}
                          {profiles.map((profile) => (
                            <DropdownMenuCheckboxItem
                              key={profile.id}
                              checked={filters.profileIds?.includes(profile.id) ?? false}
                              onCheckedChange={(checked) =>
                                onFiltersChange({
                                  ...filters,
                                  profileIds: toggleList(filters.profileIds, [profile.id], checked),
                                })
                              }
                              onSelect={(e) => e.preventDefault()}
                            >
                              <span className="truncate">{profileOptionLabel(profile)}</span>
                            </DropdownMenuCheckboxItem>
                          ))}
                        </DropdownMenuGroup>
                      ))}
                    </div>
                  </ScrollArea>
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}

            {/* Platform filter - multi-select */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Monitor className="mr-2 h-4 w-4" />
                {t('pages:activity.platforms')}
                {filters.platforms?.length ? (
                  <Badge variant="secondary" className="ml-auto h-5 px-1.5">
                    {filters.platforms.length}
                  </Badge>
                ) : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="p-0">
                <ScrollArea className="h-[250px]">
                  <div className="p-1">
                    {filters.platforms?.length ? (
                      <>
                        <DropdownMenuItem onClick={() => removeFilter('platforms')}>
                          <X />
                          {t('pages:history.filters.clearPlatforms')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    {filterOptions?.platforms?.map((opt) => {
                      const isSelected = filters.platforms?.includes(opt.value) ?? false;
                      return (
                        <DropdownMenuCheckboxItem
                          key={opt.value}
                          checked={isSelected}
                          onCheckedChange={(checked) =>
                            onFiltersChange({
                              ...filters,
                              platforms: toggleList(filters.platforms, [opt.value], checked),
                            })
                          }
                          onSelect={(e) => e.preventDefault()}
                        >
                          <Monitor className="text-muted-foreground mr-2 h-4 w-4" />
                          <span className="flex-1 truncate">{opt.value}</span>
                          <Badge variant="secondary" className="ml-2">
                            {opt.count}
                          </Badge>
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </div>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {/* Country filter - multi-select */}
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <Globe className="mr-2 h-4 w-4" />
                {t('pages:history.filters.countries')}
                {filters.geoCountries?.length ? (
                  <Badge variant="secondary" className="ml-auto h-5 px-1.5">
                    {filters.geoCountries.length}
                  </Badge>
                ) : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="p-0">
                <ScrollArea className="h-[250px]">
                  <div className="p-1">
                    {filters.geoCountries?.length ? (
                      <>
                        <DropdownMenuItem onClick={() => removeFilter('geoCountries')}>
                          <X />
                          {t('pages:history.filters.clearCountries')}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                      </>
                    ) : null}
                    {filterOptions?.countries?.map((opt) => {
                      const isSelected = filters.geoCountries?.includes(opt.value) ?? false;
                      return (
                        <DropdownMenuCheckboxItem
                          key={opt.value}
                          checked={isSelected}
                          onCheckedChange={(checked) =>
                            onFiltersChange({
                              ...filters,
                              geoCountries: toggleList(filters.geoCountries, [opt.value], checked),
                            })
                          }
                          onSelect={(e) => e.preventDefault()}
                        >
                          <Globe className="text-muted-foreground mr-2 h-4 w-4" />
                          <span className="flex-1 truncate">{opt.value}</span>
                          <Badge variant="secondary" className="ml-2">
                            {opt.count}
                          </Badge>
                        </DropdownMenuCheckboxItem>
                      );
                    })}
                  </div>
                </ScrollArea>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            <DropdownMenuSeparator />

            {/* Media Type - multi-select checkboxes */}
            <DropdownMenuLabel className="flex items-center justify-between">
              {t('pages:history.filters.mediaType')}
              {filters.mediaTypes?.length ? (
                <Badge variant="secondary" className="h-5 px-1.5">
                  {filters.mediaTypes.length}
                </Badge>
              ) : null}
            </DropdownMenuLabel>
            {mediaTypeOptions.map(({ value, label, icon: Icon }) => {
              const isSelected = filters.mediaTypes?.includes(value) ?? false;
              return (
                <DropdownMenuCheckboxItem
                  key={value}
                  checked={isSelected}
                  onCheckedChange={(checked) =>
                    onFiltersChange({
                      ...filters,
                      mediaTypes: toggleList(filters.mediaTypes, [value], checked),
                    })
                  }
                  onSelect={(e) => e.preventDefault()}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                </DropdownMenuCheckboxItem>
              );
            })}

            <DropdownMenuSeparator />

            {/* Quality - multi-select checkboxes */}
            <DropdownMenuLabel className="flex items-center justify-between">
              {t('common:labels.quality')}
              {filters.transcodeDecisions?.length ? (
                <Badge variant="secondary" className="h-5 px-1.5">
                  {filters.transcodeDecisions.length}
                </Badge>
              ) : null}
            </DropdownMenuLabel>
            {PLAYBACK_DECISIONS.map((value) => {
              const Icon = PLAYBACK_DECISION_ICONS[value];
              const label = t(PLAYBACK_DECISION_LABEL_KEYS[value]);
              const isSelected = filters.transcodeDecisions?.includes(value) ?? false;
              return (
                <DropdownMenuCheckboxItem
                  key={value}
                  checked={isSelected}
                  onCheckedChange={(checked) =>
                    onFiltersChange({
                      ...filters,
                      transcodeDecisions: toggleList(filters.transcodeDecisions, [value], checked),
                    })
                  }
                  onSelect={(e) => e.preventDefault()}
                >
                  <Icon className="mr-2 h-4 w-4" />
                  {label}
                </DropdownMenuCheckboxItem>
              );
            })}
            <DropdownMenuCheckboxItem
              checked={filters.subtitleBurnIn === true}
              onCheckedChange={(checked) =>
                onFiltersChange({ ...filters, subtitleBurnIn: checked ? true : undefined })
              }
              onSelect={(e) => e.preventDefault()}
            >
              <Subtitles className="mr-2 h-4 w-4" />
              {t('playback.burnIn')}
            </DropdownMenuCheckboxItem>

            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('pages:history.filters.network')}</DropdownMenuLabel>
            {(['local', 'remote'] as const).map((value) => (
              <DropdownMenuCheckboxItem
                key={value}
                checked={filters.network === value}
                onCheckedChange={(checked) => {
                  const { network: _, ...rest } = filters;
                  onFiltersChange(checked ? { ...rest, network: value } : rest);
                }}
                onSelect={(e) => e.preventDefault()}
              >
                {value === 'local' ? (
                  <Wifi className="mr-2 h-4 w-4" />
                ) : (
                  <Globe className="mr-2 h-4 w-4" />
                )}
                {value === 'local' ? t('common:labels.local') : t('pages:history.filters.remote')}
              </DropdownMenuCheckboxItem>
            ))}

            {/* Clear all button */}
            {hasActiveFilters && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={clearFilters} className="text-muted-foreground">
                  <X />
                  {t('pages:history.filters.clearFilters')}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Column visibility dropdown - shadcn pattern */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5">
              <Columns3 className="h-4 w-4" />
              {t('pages:history.filters.columns')}
              {shownColumnCount < menuColumns.length && (
                <Badge variant="secondary" className="ml-1 h-5 px-1.5">
                  {shownColumnCount}
                </Badge>
              )}
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {menuColumns.map((column) => (
              <DropdownMenuCheckboxItem
                key={column.id}
                checked={columnVisibility[column.id]}
                onCheckedChange={(checked) => onColumnToggle(column.id, checked)}
              >
                {t(column.labelKey)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {isFetching && (
          <div className="text-muted-foreground flex items-center gap-2 text-xs">
            <div className="border-primary h-4 w-4 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        )}
      </div>

      {/* Row 2: Active filters as chips (only show if filters are applied) */}
      {hasActiveFilters && (
        <div className="flex flex-wrap items-center gap-2">
          {activeFilters.map((filter) => (
            <FilterChip
              key={filter.key}
              label={filter.label}
              value={filter.value}
              icon={filter.icon}
              onRemove={() => removeFilter(filter.key)}
            />
          ))}

          {filters.search && (
            <FilterChip
              label={t('common:actions.search')}
              value={filters.search}
              icon={Search}
              onRemove={() => {
                setSearchInput('');
                removeFilter('search');
              }}
            />
          )}

          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-7 gap-1 px-2 text-xs"
            onClick={clearFilters}
          >
            <X className="h-3.5 w-3.5" />
            {t('common:filters.clearAll')}
          </Button>
        </div>
      )}
    </div>
  );
}
