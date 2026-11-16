import { useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { LOCATION_LIST_PEOPLE, type LocationStats } from '@tracearr/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LocalBadge } from '@/components/sessions/LocalBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { hasMapPosition, inView, type ViewBounds } from './maplibre';
import { locationKey, locationName } from './locationKey';

const ROW_HEIGHT = 44;

interface LocationListProps {
  /** Ranked by streams. */
  locations: LocationStats[];
  /** The map view; placed rows outside it are left out. */
  bounds?: ViewBounds | null;
  isLoading?: boolean;
  hoveredKeys: ReadonlySet<string>;
  onHover: (key: string | null) => void;
  onSelect: (key: string) => void;
  onShowAll?: () => void;
}

export function LocationList({
  locations,
  bounds,
  isLoading,
  hoveredKeys,
  onHover,
  onSelect,
  onShowAll,
}: LocationListProps) {
  const { t } = useTranslation(['pages']);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { rows, anyPlaced, placedInView } = useMemo(() => {
    const ranked = locations.map((location, i) => ({ location, rank: i + 1 }));
    const placed = ranked.filter(
      (r) => hasMapPosition(r.location) && (!bounds || inView(r.location, bounds))
    );
    const unplaced = ranked.filter((r) => !hasMapPosition(r.location));
    return {
      rows: [...placed, ...unplaced],
      anyPlaced: unplaced.length < ranked.length,
      placedInView: placed.length,
    };
  }, [locations, bounds]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const topCount = locations[0]?.count ?? 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-baseline justify-between gap-2 border-b px-4 py-2.5">
        <div className="flex items-baseline gap-2">
          <h2 className="text-sm font-semibold">{t('userDetail.locations')}</h2>
          {rows.length < locations.length && (
            <span className="text-muted-foreground text-xs tabular-nums">
              {t('map.inViewCount', { count: rows.length, total: locations.length })}
            </span>
          )}
        </div>
        <span className="text-muted-foreground text-xs">{t('map.byStreams')}</span>
      </div>
      {!isLoading && anyPlaced && placedInView === 0 && (
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <p className="text-muted-foreground text-sm">{t('map.noneInView')}</p>
          <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onShowAll}>
            {t('map.showAll')}
          </Button>
        </div>
      )}
      {isLoading ? (
        <div className="space-y-1 p-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </div>
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 scrollbar-thin overflow-auto">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const row = rows[item.index];
              if (!row) return null;
              const { location, rank } = row;
              const key = locationKey(location);
              return (
                <LocationRow
                  key={key}
                  location={location}
                  rank={rank}
                  share={topCount > 0 ? location.count / topCount : 0}
                  hovered={hoveredKeys.has(key)}
                  start={item.start}
                  onHover={(hovering) => onHover(hovering ? key : null)}
                  onSelect={() => onSelect(key)}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function LocationRow({
  location,
  rank,
  share,
  hovered,
  start,
  onHover,
  onSelect,
}: {
  location: LocationStats;
  rank: number;
  share: number;
  hovered: boolean;
  start: number;
  onHover: (hovering: boolean) => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation(['pages']);
  const place = [location.region, location.country].filter(Boolean).join(' · ');
  const people = location.users ?? [];
  const shown = people.slice(0, LOCATION_LIST_PEOPLE);
  const more = location.peopleCount - shown.length;

  return (
    <button
      type="button"
      data-key={locationKey(location)}
      data-hovered={hovered || undefined}
      className="hover:bg-muted/60 data-[hovered=true]:bg-muted absolute top-0 left-0 flex w-full items-center gap-3 px-4 text-left"
      style={{ height: ROW_HEIGHT, transform: `translateY(${start}px)` }}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onHover(true)}
      onBlur={() => onHover(false)}
      onClick={onSelect}
    >
      <span className="text-muted-foreground w-5 shrink-0 text-right text-xs tabular-nums">
        {rank}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{locationName(location)}</span>
          <LocalBadge isLocal={location.isLocal} country={location.country} />
        </div>
        <div className="text-muted-foreground flex gap-1 truncate text-xs">
          <span>{place}</span>
          {!hasMapPosition(location) && (
            <>
              <span aria-hidden>·</span>
              <span>{t('map.noMapPosition')}</span>
            </>
          )}
        </div>
      </div>
      {shown.length > 0 && (
        <div className="flex shrink-0 items-center -space-x-1.5">
          {shown.map((person) => {
            const name = person.identityName ?? person.username;
            return (
              <Avatar key={person.id} className="ring-background h-6 w-6 ring-2">
                <AvatarImage
                  src={getAvatarUrl(person.serverId, person.thumbUrl, 24) ?? undefined}
                />
                <AvatarFallback className="text-xs">{name[0]?.toUpperCase() ?? '?'}</AvatarFallback>
              </Avatar>
            );
          })}
          {more > 0 && (
            <span className="text-muted-foreground pl-2.5 text-xs tabular-nums">+{more}</span>
          )}
        </div>
      )}
      <span className="w-12 shrink-0 text-right text-sm font-medium tabular-nums">
        {location.count.toLocaleString()}
      </span>
      <span
        aria-hidden
        className="bg-primary/50 absolute bottom-0 left-0 h-0.5"
        style={{ width: `${share * 100}%` }}
      />
    </button>
  );
}
