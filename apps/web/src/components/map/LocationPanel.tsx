import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useTranslation } from 'react-i18next';
import { ArrowLeft, ArrowUpRight } from 'lucide-react';
import {
  formatEpisodeLabel,
  POSTER_IMAGE_SIZE,
  type LocationStats,
  type LocationUserInfo,
  type SessionWithDetails,
} from '@tracearr/shared';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { LocalBadge } from '@/components/sessions/LocalBadge';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { getAvatarUrl } from '@/components/users/utils';
import { useHistorySessions, type HistoryFilters } from '@/hooks/queries';
import { imageProxyUrl } from '@/lib/api';
import { getCountryName, getDeviceDisplayName, getMediaDisplay } from '@/lib/utils';
import { FULL_DATE_TIME_OPTIONS, formatDate, formatDuration } from '@/lib/dateFormat';
import { locationName } from './locationKey';

const SESSION_ROW_HEIGHT = 56;

interface LocationPanelProps {
  location: LocationStats;
  historyFilters: HistoryFilters;
  historyHref: string;
  onBack: () => void;
  onSelectPerson: (person: LocationUserInfo) => void;
  /** Server names by id; the per-server split shows when given and the location has several. */
  serverNames?: Record<string, string>;
}

export function LocationPanel({
  location,
  historyFilters,
  historyHref,
  onBack,
  onSelectPerson,
  serverNames,
}: LocationPanelProps) {
  const { t } = useTranslation(['pages', 'common', 'nav']);
  const panelRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const headingId = useId();
  const [openSession, setOpenSession] = useState<SessionWithDetails | null>(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // A native listener, not onKeyDown: React bubbles events out of portals, so Escape in the
  // session sheet would close the panel too.
  useEffect(() => {
    const panel = panelRef.current;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onBack();
    };
    panel?.addEventListener('keydown', onKeyDown);
    return () => panel?.removeEventListener('keydown', onKeyDown);
  }, [onBack]);

  const name = locationName(location);
  const place = [location.region, getCountryName(location.country)]
    .filter((part) => part && part !== name)
    .join(' · ');
  const servers = location.servers ?? [];
  const people = location.users;

  return (
    <>
      <section ref={panelRef} aria-labelledby={headingId} className="flex h-full min-h-0 flex-col">
        <div className="space-y-3 border-b px-4 pt-3 pb-3.5">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground -ml-2 h-7 gap-1.5 px-2 text-xs"
            onClick={onBack}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            {t('map.allLocations')}
          </Button>
          <div>
            <div className="flex items-center gap-2">
              <h2
                id={headingId}
                ref={headingRef}
                tabIndex={-1}
                className="text-xl font-semibold outline-none"
              >
                {name}
              </h2>
              <LocalBadge isLocal={location.isLocal} country={location.country} />
            </div>
            {place && <div className="text-muted-foreground mt-0.5 text-sm">{place}</div>}
          </div>
          <div data-testid="location-stats" className="grid grid-cols-3 gap-2">
            <Stat value={location.count} label={t('map.streams')} />
            <Stat value={location.peopleCount} label={t('map.people')} />
            <Stat value={location.deviceCount ?? 0} label={t('map.devices')} />
          </div>
          <dl className="grid grid-cols-[88px_1fr] gap-y-1.5 text-xs">
            {location.firstActivity && (
              <Detail
                term={t('map.firstSeen')}
                value={formatDate(new Date(location.firstActivity), FULL_DATE_TIME_OPTIONS)}
              />
            )}
            {location.lastActivity && (
              <Detail
                term={t('map.lastSeen')}
                value={formatDate(new Date(location.lastActivity), FULL_DATE_TIME_OPTIONS)}
              />
            )}
            {serverNames &&
              servers.length > 1 &&
              servers.map((entry) => (
                <Detail
                  key={entry.serverId}
                  term={serverNames[entry.serverId] ?? entry.serverId}
                  value={entry.count.toLocaleString()}
                />
              ))}
          </dl>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 px-4 pt-3.5">
          {people && people.length > 0 && (
            <section className="max-h-[40%] shrink-0 scrollbar-thin overflow-auto">
              <SectionHeading>{t('nav:people')}</SectionHeading>
              <div data-testid="location-people" className="-mx-2 flex flex-col">
                {people.map((person) => (
                  <PersonRow key={person.id} person={person} onSelect={onSelectPerson} />
                ))}
              </div>
            </section>
          )}
          <section className="flex min-h-0 flex-1 flex-col">
            <SectionHeading>{t('map.latestStreams')}</SectionHeading>
            <SessionList filters={historyFilters} onOpen={setOpenSession} />
          </section>
        </div>

        <div className="border-t px-4 py-3">
          <Button asChild className="w-full">
            <Link to={historyHref}>
              {t('map.viewInHistory', { count: location.count })}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      </section>
      <SessionDetailSheet
        session={openSession}
        open={openSession !== null}
        onOpenChange={(open) => {
          if (!open) setOpenSession(null);
        }}
      />
    </>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="bg-muted/60 rounded-md px-2.5 py-2">
      <div className="text-lg font-semibold tabular-nums">{value.toLocaleString()}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function Detail({ term, value }: { term: string; value: string }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground truncate">{term}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

export function SectionHeading({ children }: { children: string }) {
  return (
    <h3 className="text-muted-foreground mb-2 text-xs font-semibold tracking-wider uppercase">
      {children}
    </h3>
  );
}

export function PersonRow({
  person,
  onSelect,
}: {
  person: LocationUserInfo;
  onSelect: (person: LocationUserInfo) => void;
}) {
  const { t } = useTranslation(['pages']);
  const name = person.identityName ?? person.username;
  return (
    <button
      type="button"
      className="hover:bg-muted/60 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left"
      onClick={() => onSelect(person)}
    >
      <Avatar className="h-7 w-7">
        <AvatarImage src={getAvatarUrl(person.serverId, person.thumbUrl, 28) ?? undefined} />
        <AvatarFallback className="text-xs">{name[0]?.toUpperCase() ?? '?'}</AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{name}</span>
      <span className="text-muted-foreground shrink-0 text-xs">
        {t('map.streamCount', { count: person.count })}
      </span>
    </button>
  );
}

function SessionList({
  filters,
  onOpen,
}: {
  filters: HistoryFilters;
  onOpen: (session: SessionWithDetails) => void;
}) {
  const { t } = useTranslation(['common']);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { data, isLoading, hasNextPage, isFetchingNextPage, fetchNextPage } =
    useHistorySessions(filters);
  const sessions = useMemo(() => data?.pages.flatMap((page) => page.data) ?? [], [data]);

  const virtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => SESSION_ROW_HEIGHT,
    overscan: 10,
  });

  useEffect(() => {
    const scrollEl = scrollRef.current;
    if (!scrollEl || !hasNextPage || isFetchingNextPage) return;
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      if (scrollHeight - scrollTop - clientHeight < 200) void fetchNextPage();
    };
    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  return (
    <div
      ref={scrollRef}
      data-testid="location-sessions"
      className="-mx-2 min-h-0 flex-1 scrollbar-thin overflow-auto pb-2"
    >
      {isLoading ? (
        <div className="space-y-1 px-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : sessions.length === 0 ? (
        <p className="text-muted-foreground px-2 py-4 text-sm">{t('empty.noSessionsFound')}</p>
      ) : (
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const session = sessions[item.index];
            if (!session) return null;
            return (
              <SessionRow
                key={session.id}
                session={session}
                start={item.start}
                onOpen={() => onOpen(session)}
              />
            );
          })}
        </div>
      )}
      {isFetchingNextPage && (
        <div className="space-y-1 px-2 pt-1">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      )}
    </div>
  );
}

function SessionRow({
  session,
  start,
  onOpen,
}: {
  session: SessionWithDetails;
  start: number;
  onOpen: () => void;
}) {
  const { title } = getMediaDisplay(session);
  const details = [
    formatEpisodeLabel(session.seasonNumber, session.episodeNumber, {
      spaced: true,
      mediaType: session.mediaType,
    }),
    session.user.identityName ?? session.user.username,
    getDeviceDisplayName(session),
    session.durationMs ? formatDuration(session.durationMs, { style: 'compactShort' }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const posterUrl = session.thumbPath
    ? imageProxyUrl(
        session.serverId,
        session.thumbPath,
        POSTER_IMAGE_SIZE.width,
        POSTER_IMAGE_SIZE.height,
        'poster'
      )
    : null;
  const startedAt = new Date(session.startedAt);

  return (
    <button
      type="button"
      className="hover:bg-muted/60 absolute top-0 left-0 flex w-full items-center gap-2.5 rounded-md px-2 text-left"
      style={{ height: SESSION_ROW_HEIGHT, transform: `translateY(${start}px)` }}
      onClick={onOpen}
    >
      <div className="bg-muted h-11 w-[30px] shrink-0 overflow-hidden rounded-sm">
        {posterUrl && (
          <img src={posterUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="text-muted-foreground truncate text-xs">{details}</div>
      </div>
      <div className="text-muted-foreground shrink-0 text-right text-xs leading-tight">
        <div>{formatDate(startedAt, { month: 'short', day: 'numeric' })}</div>
        <div>{formatDate(startedAt, { hour: 'numeric', minute: '2-digit' })}</div>
      </div>
    </button>
  );
}
