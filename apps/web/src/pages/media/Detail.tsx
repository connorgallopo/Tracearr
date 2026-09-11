import { useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { format } from 'date-fns';
import type { MediaRequestEntry } from '@tracearr/shared';
import { ApiError } from '@/lib/api';
import {
  useMediaDetail,
  useMediaStats,
  useMediaWatchers,
  useSeasonHeat,
  useMediaPlatforms,
  useMediaHistory,
  useSession,
  useMediaRequests,
  findCachedMediaStub,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { SessionDetailSheet } from '@/components/history/SessionDetailSheet';
import { DetailHero } from '@/components/media-browse/DetailHero';
import { CopiesPanel } from '@/components/media-browse/CopiesPanel';
import { KpiStrip } from '@/components/media-browse/KpiStrip';
import { WatchersTable } from '@/components/media-browse/WatchersTable';
import { SeasonHeatPanel } from '@/components/media-browse/SeasonHeatPanel';
import { PlatformPanel } from '@/components/media-browse/PlatformPanel';
import { MediaRequestsPanel } from '@/components/requests/MediaRequestsPanel';
import { InlineErrorState } from '@/components/library/ErrorState';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { formatDuration } from '@/lib/formatters';
import { getTimeFormatString } from '@/lib/timeFormat';
import { cn } from '@/lib/utils';
import { getAvatarUrl } from '@/components/users/utils';

const HISTORY_ROW_HEIGHT = 56;

// Shared by the header row and every virtualized data row so both size their
// columns identically - date, user, content (flexible), server, duration.
const HISTORY_GRID_TEMPLATE = '160px 160px minmax(200px,1fr) 140px 100px';
const HISTORY_HEAD_CLASS = 'text-foreground h-10 px-2 font-medium whitespace-nowrap';
const HISTORY_CELL_CLASS = 'p-2 whitespace-nowrap';

function NotFoundState() {
  const { t } = useTranslation('pages');
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-4 py-20 text-center">
      <h1 className="text-xl font-semibold">{t('media.detail.notFound.title')}</h1>
      <p className="text-muted-foreground max-w-md text-sm">{t('media.detail.notFound.message')}</p>
      <Button asChild variant="outline">
        <Link to="/media">{t('media.detail.notFound.backLink')}</Link>
      </Button>
    </div>
  );
}

function HistoryPanelSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 5 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

interface HistoryRow {
  id: string;
  server_id: string;
  server_name: string;
  media_title: string;
  started_at: string;
  duration_ms: number | null;
  watched: boolean;
  user: {
    id: string;
    server_user_id: string;
    username: string;
    thumb_url: string | null;
  };
}

function HistoryPanel({
  historyRef,
  rows,
  isLoading,
  isError,
  onRetry,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
  onRowClick,
}: {
  historyRef: RefObject<HTMLDivElement | null>;
  rows: HistoryRow[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
  onRowClick: (sessionId: string) => void;
}) {
  const { t } = useTranslation('pages');
  const scrollRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => HISTORY_ROW_HEIGHT,
    overscan: 8,
  });

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el || !hasNextPage || isFetchingNextPage) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) onLoadMore();
  };

  return (
    <section
      id="full-history"
      ref={historyRef}
      aria-labelledby="history-heading"
      className="bg-card scroll-mt-6 rounded-[calc(var(--radius)+2px)] border p-[16px_18px]"
    >
      <h2 id="history-heading" className="mb-3 text-[15px] font-semibold">
        {t('media.detail.history.title')}
      </h2>

      {isError ? (
        <InlineErrorState message={t('media.detail.history.loadError')} onRetry={onRetry} />
      ) : isLoading ? (
        <HistoryPanelSkeleton />
      ) : rows.length === 0 ? (
        <EmptyState title={t('media.detail.history.empty')} className="py-6" />
      ) : (
        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="relative scrollbar-thin overflow-auto"
          style={{ maxHeight: 480 }}
        >
          {/* role="table"/"row"/"cell" over a CSS grid, not a real <table>: a
              real table's TableBody needed display:block for virtualization,
              which pulls it out of the table's own layout algorithm - the
              header (still a real table row) then auto-sized off its own
              short labels instead of matching the body's fixed column
              widths. One grid-template-columns, shared by the header and
              every row, keeps both column sets identical by construction. */}
          <div role="table" aria-label={t('media.detail.history.title')} className="w-full text-sm">
            <div role="rowgroup" className="bg-card sticky top-0 z-10">
              <div
                role="row"
                className="border-b"
                style={{
                  display: 'grid',
                  gridTemplateColumns: HISTORY_GRID_TEMPLATE,
                  alignItems: 'center',
                }}
              >
                <div role="columnheader" className={HISTORY_HEAD_CLASS}>
                  {t('media.detail.history.columns.date')}
                </div>
                <div role="columnheader" className={HISTORY_HEAD_CLASS}>
                  {t('media.detail.history.columns.user')}
                </div>
                <div role="columnheader" className={HISTORY_HEAD_CLASS}>
                  {t('media.detail.history.columns.content')}
                </div>
                <div role="columnheader" className={HISTORY_HEAD_CLASS}>
                  {t('media.detail.history.columns.server')}
                </div>
                <div role="columnheader" className={cn(HISTORY_HEAD_CLASS, 'text-right')}>
                  {t('media.detail.history.columns.duration')}
                </div>
              </div>
            </div>
            <div
              role="rowgroup"
              style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const row = rows[virtualRow.index];
                if (!row) return null;
                return (
                  <div
                    key={row.id}
                    role="row"
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    tabIndex={0}
                    onClick={() => onRowClick(row.id)}
                    onKeyDown={(event) => {
                      if (event.target !== event.currentTarget) return;
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        onRowClick(row.id);
                      }
                    }}
                    className="hover:bg-muted/50 focus-visible:ring-ring cursor-pointer border-b transition-colors focus-visible:ring-2 focus-visible:outline-none focus-visible:ring-inset"
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      // max-content, not a flat 100% of the rowgroup, so the row covers the full scrolled width.
                      minWidth: '100%',
                      width: 'max-content',
                      transform: `translateY(${virtualRow.start}px)`,
                      display: 'grid',
                      gridTemplateColumns: HISTORY_GRID_TEMPLATE,
                      alignItems: 'center',
                    }}
                  >
                    <div role="cell" className={HISTORY_CELL_CLASS}>
                      <div className="text-sm">
                        {format(new Date(row.started_at), 'MMM d, yyyy')}
                      </div>
                      <div className="text-muted-foreground text-xs">
                        {format(new Date(row.started_at), getTimeFormatString())}
                      </div>
                    </div>
                    <div role="cell" className={HISTORY_CELL_CLASS}>
                      {row.user.server_user_id ? (
                        <Link
                          to={`/users/${row.user.server_user_id}`}
                          onClick={(event) => event.stopPropagation()}
                          className="flex items-center gap-2 hover:underline"
                        >
                          <Avatar className="h-6 w-6">
                            <AvatarImage
                              src={getAvatarUrl(row.server_id, row.user.thumb_url, 24) ?? undefined}
                            />
                            <AvatarFallback className="text-xs">
                              {row.user.username[0]?.toUpperCase() ?? '?'}
                            </AvatarFallback>
                          </Avatar>
                          <span className="truncate text-sm">{row.user.username}</span>
                        </Link>
                      ) : (
                        <div className="flex items-center gap-2">
                          <Avatar className="h-6 w-6">
                            <AvatarImage
                              src={getAvatarUrl(row.server_id, row.user.thumb_url, 24) ?? undefined}
                            />
                            <AvatarFallback className="text-xs">
                              {row.user.username[0]?.toUpperCase() ?? '?'}
                            </AvatarFallback>
                          </Avatar>
                          <span className="truncate text-sm">{row.user.username}</span>
                        </div>
                      )}
                    </div>
                    <div role="cell" className={cn(HISTORY_CELL_CLASS, 'min-w-0')}>
                      <div className="flex items-center gap-2">
                        <span className="truncate">{row.media_title}</span>
                        <Badge variant={row.watched ? 'success' : 'outline'} className="text-xs">
                          {row.watched
                            ? t('media.detail.history.watched')
                            : t('media.detail.history.notWatched')}
                        </Badge>
                      </div>
                    </div>
                    <div role="cell" className={cn(HISTORY_CELL_CLASS, 'truncate')}>
                      {row.server_name}
                    </div>
                    <div role="cell" className={cn(HISTORY_CELL_CLASS, 'text-right tabular-nums')}>
                      {formatDuration(row.duration_ms, { style: 'compactShort' })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          {isFetchingNextPage && <HistoryPanelSkeleton />}
        </div>
      )}
    </section>
  );
}

export function MediaDetail() {
  const { id: rawId } = useParams<{ id: string }>();
  const id = rawId ?? '';
  const { selectedServerIds, servers } = useServer();
  const queryClient = useQueryClient();
  const historyRef = useRef<HTMLDivElement>(null);
  // A history row's id is its chain id (the chain's first session id), so the
  // existing single-session endpoint resolves it - same as History deep-links.
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const { data: selectedSession } = useSession(selectedSessionId ?? '');

  const serverById = useMemo(
    () =>
      new Map(
        servers.map((server) => [
          server.id,
          {
            name: server.name,
            type: server.type,
            color: server.color,
            url: server.url,
            machineIdentifier: server.machineIdentifier,
          },
        ])
      ),
    [servers]
  );

  const stub = useMemo(
    () => (id ? findCachedMediaStub(queryClient, id) : undefined),
    [queryClient, id]
  );

  const detailQuery = useMediaDetail(id, selectedServerIds, 'all', stub);
  const statsQuery = useMediaStats(id, selectedServerIds);
  const watchersQuery = useMediaWatchers(id, selectedServerIds);
  const mediaType = detailQuery.data?.mediaType;
  const isShow = mediaType === 'show';
  const seasonHeatQuery = useSeasonHeat(id, selectedServerIds, isShow);
  const platformsQuery = useMediaPlatforms(id, selectedServerIds);
  const historyQuery = useMediaHistory(id, selectedServerIds);
  const requestsQuery = useMediaRequests(id, selectedServerIds);

  // requestedAt is a fixed-width UTC ISO string from the API, so comparing the
  // strings orders them chronologically.
  const primaryRequest = useMemo(() => {
    const live = (requestsQuery.data?.data ?? []).filter((entry) => entry.deletedAt === null);
    return live.reduce<MediaRequestEntry | null>(
      (earliest, entry) =>
        earliest === null || entry.requestedAt < earliest.requestedAt ? entry : earliest,
      null
    );
  }, [requestsQuery.data]);

  const notFoundStatus =
    detailQuery.error instanceof ApiError &&
    (detailQuery.error.status === 404 || detailQuery.error.status === 400);
  const isNotFound = !id || (detailQuery.isError && notFoundStatus);

  if (isNotFound) {
    return <NotFoundState />;
  }

  const historyRows = historyQuery.data?.pages.flatMap((page) => page.data) ?? [];

  return (
    <div className="space-y-6">
      <DetailHero
        data={detailQuery.data}
        stub={stub}
        isLoading={detailQuery.isLoading}
        isError={detailQuery.isError}
        onRetry={() => void detailQuery.refetch()}
        serverById={serverById}
        request={primaryRequest}
        onFullHistoryClick={() => {
          historyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }}
      />

      <CopiesPanel
        availability={detailQuery.data?.availability}
        isLoading={detailQuery.isLoading}
        isError={detailQuery.isError}
        onRetry={() => void detailQuery.refetch()}
        serverById={serverById}
      />

      {mediaType !== 'episode' && (
        <MediaRequestsPanel
          rows={requestsQuery.data?.data}
          isLoading={requestsQuery.isLoading}
          isError={requestsQuery.isError}
          onRetry={() => void requestsQuery.refetch()}
        />
      )}

      <KpiStrip
        mediaType={mediaType}
        stats={statsQuery.data}
        statsLoading={statsQuery.isLoading}
        statsError={statsQuery.isError}
        onRetryStats={() => void statsQuery.refetch()}
        watchers={watchersQuery.data?.watchers}
        watchersLoading={watchersQuery.isLoading}
        watchersError={watchersQuery.isError}
        onRetryWatchers={() => void watchersQuery.refetch()}
      />

      <WatchersTable
        watchers={watchersQuery.data?.watchers}
        isLoading={watchersQuery.isLoading}
        isError={watchersQuery.isError}
        onRetry={() => void watchersQuery.refetch()}
        mediaType={mediaType}
        episodeCount={detailQuery.data?.episodeCount}
      />

      {isShow && (
        <SeasonHeatPanel
          seasons={seasonHeatQuery.data?.seasons}
          isLoading={seasonHeatQuery.isLoading}
          isError={seasonHeatQuery.isError}
          onRetry={() => void seasonHeatQuery.refetch()}
        />
      )}

      <PlatformPanel
        data={platformsQuery.data?.data}
        isLoading={platformsQuery.isLoading}
        isError={platformsQuery.isError}
        onRetry={() => void platformsQuery.refetch()}
      />

      <HistoryPanel
        historyRef={historyRef}
        rows={historyRows}
        isLoading={historyQuery.isLoading}
        isError={historyQuery.isError}
        onRetry={() => void historyQuery.refetch()}
        hasNextPage={!!historyQuery.hasNextPage}
        isFetchingNextPage={historyQuery.isFetchingNextPage}
        onLoadMore={() => void historyQuery.fetchNextPage()}
        onRowClick={setSelectedSessionId}
      />

      <SessionDetailSheet
        session={selectedSessionId ? (selectedSession ?? null) : null}
        open={!!selectedSessionId && !!selectedSession}
        onOpenChange={(open) => {
          if (!open) setSelectedSessionId(null);
        }}
      />
    </div>
  );
}
