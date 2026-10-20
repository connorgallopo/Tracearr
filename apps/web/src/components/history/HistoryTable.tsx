/**
 * Table component for displaying history sessions.
 * Features columns for all session data, supports virtual scroll and column visibility.
 */

import { forwardRef, useRef, useEffect, memo } from 'react';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link } from 'react-router';
import {
  Film,
  Tv,
  Music,
  Radio,
  Image,
  CircleHelp,
  Play,
  Pause,
  Globe,
  Clock,
  Clapperboard,
  Subtitles,
} from 'lucide-react';
import { TableCell, TableHead, TableRow } from '@/components/ui/table';
import { DATA_TABLE_VIEWPORT_MAX_HEIGHT } from '@/components/ui/data-table';
import { SortableTableHead } from '@/components/ui/sortable-table-head';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import {
  cn,
  formatLocationCompact,
  getCountryName,
  getMediaDisplay,
  getMediaLinks,
  getSessionProgress,
} from '@/lib/utils';
import { MediaPageLink } from '@/components/media/MediaPageLink';
import { formatDuration } from '@/lib/formatters';
import { playbackBadge } from '@/lib/playbackBadge';
import { getAvatarUrl } from '@/components/users/utils';
import { LocalBadge } from '@/components/sessions/LocalBadge';
import {
  PLAYBACK_DECISION_LABEL_KEYS,
  type SessionWithDetails,
  type SessionState,
  type MediaType,
  type EngagementTier,
} from '@tracearr/shared';
import type { ColumnVisibility } from './HistoryFilters';
import { ServerColumnCell } from '@/components/server';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import { format } from 'date-fns';
import { getTimeFormatString } from '@/lib/timeFormat';

// Engagement tier config
const ENGAGEMENT_TIER_CONFIG: Record<
  EngagementTier,
  { label: string; shortLabel: string; color: string; bgClass: string }
> = {
  abandoned: {
    label: 'Abandoned (<20%)',
    shortLabel: 'Abandoned',
    color: 'text-red-600',
    bgClass: 'bg-red-100 dark:bg-red-900/30',
  },
  sampled: {
    label: 'Sampled (20-49%)',
    shortLabel: 'Sampled',
    color: 'text-orange-600',
    bgClass: 'bg-orange-100 dark:bg-orange-900/30',
  },
  engaged: {
    label: 'Engaged (50-84%)',
    shortLabel: 'Engaged',
    color: 'text-yellow-600',
    bgClass: 'bg-yellow-100 dark:bg-yellow-900/30',
  },
  watched: {
    label: 'Watched (85%+)',
    shortLabel: 'Watched',
    color: 'text-green-600',
    bgClass: 'bg-green-100 dark:bg-green-900/30',
  },
  rewatched: {
    label: 'Rewatched (200%+)',
    shortLabel: 'Rewatched',
    color: 'text-blue-600',
    bgClass: 'bg-blue-100 dark:bg-blue-900/30',
  },
  unknown: {
    label: 'Unknown',
    shortLabel: '?',
    color: 'text-muted-foreground',
    bgClass: 'bg-muted',
  },
};

function getEngagementTier(progress: number | null): EngagementTier {
  if (progress === null) return 'unknown';
  if (progress >= 200) return 'rewatched';
  if (progress >= 85) return 'watched';
  if (progress >= 50) return 'engaged';
  if (progress >= 20) return 'sampled';
  return 'abandoned';
}

function EngagementTierBadge({
  progress,
  state,
}: {
  progress: number | null;
  state: SessionState;
}) {
  const tier = getEngagementTier(progress);
  if (tier === 'unknown' || state !== 'stopped') return null;

  const config = ENGAGEMENT_TIER_CONFIG[tier];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'rounded px-1 py-0.5 text-[10px] font-medium',
            config.color,
            config.bgClass
          )}
        >
          {config.shortLabel}
        </span>
      </TooltipTrigger>
      <TooltipContent>{config.label}</TooltipContent>
    </Tooltip>
  );
}

// Sortable column keys that the API supports
export type SortableColumn = 'startedAt' | 'durationMs' | 'mediaTitle';
export type SortDirection = 'asc' | 'desc';

interface Props {
  sessions: SessionWithDetails[];
  isLoading?: boolean;
  isFetching?: boolean;
  isFetchingNextPage?: boolean;
  hasNextPage?: boolean;
  onLoadMore?: () => void;
  onSessionClick?: (session: SessionWithDetails) => void;
  columnVisibility: ColumnVisibility;
  sortBy?: SortableColumn;
  sortDir?: SortDirection;
  onSortChange?: (column: SortableColumn) => void;
  isMultiServer?: boolean;
}

// State icon component
function StateIcon({ state }: { state: SessionState }) {
  // keeps the date column aligned across playing and stopped rows
  if (state === 'stopped') return <span className="size-4 shrink-0" aria-hidden="true" />;

  const config: Record<'playing' | 'paused', { icon: typeof Play; color: string; label: string }> =
    {
      playing: { icon: Play, color: 'text-green-500', label: 'Playing' },
      paused: { icon: Pause, color: 'text-yellow-500', label: 'Paused' },
    };
  const { icon: Icon, color, label } = config[state];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Icon className={cn('h-4 w-4', color)} />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

// Media type icon component
function MediaTypeIcon({ type }: { type: MediaType }) {
  const config: Record<MediaType, { icon: typeof Film; label: string }> = {
    movie: { icon: Film, label: 'Movie' },
    episode: { icon: Tv, label: 'TV Episode' },
    track: { icon: Music, label: 'Music' },
    live: { icon: Radio, label: 'Live TV' },
    photo: { icon: Image, label: 'Photo' },
    trailer: { icon: Clapperboard, label: 'Trailer' },
    unknown: { icon: CircleHelp, label: 'Unknown' },
  };
  const { icon: Icon, label } = config[type];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Icon className="text-muted-foreground h-4 w-4" />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

interface HistoryTableRowProps {
  session: SessionWithDetails;
  onClick?: () => void;
  columnVisibility: ColumnVisibility;
  isMultiServer?: boolean;
  style?: React.CSSProperties;
  'data-index'?: number;
}

// Session row component with column visibility support
export const HistoryTableRow = memo(
  forwardRef<HTMLTableRowElement, HistoryTableRowProps>(
    (
      { session, onClick, columnVisibility, isMultiServer = false, style, 'data-index': dataIndex },
      ref
    ) => {
      const { title: primary, subtitle: secondary } = getMediaDisplay(session);
      const mediaLinks = getMediaLinks(session);
      const progress = getSessionProgress(session);
      const colorMap = useServerColorMap();
      const { t } = useTranslation();
      const serverColor = isMultiServer ? (colorMap.get(session.serverId) ?? null) : null;
      const accentStyle = serverColor
        ? { ...style, boxShadow: `inset 3px 0 0 0 ${serverColor}` }
        : style;

      return (
        <TableRow
          ref={ref}
          data-index={dataIndex}
          style={accentStyle}
          className={cn('cursor-pointer transition-colors', onClick && 'hover:bg-muted/50')}
          onClick={onClick}
        >
          {/* Date/Time with State */}
          {columnVisibility.date && (
            <TableCell className={COLUMN_WIDTHS.date}>
              <div className="flex items-center gap-2">
                <StateIcon state={session.state} />
                <div>
                  <div className="text-sm font-medium">
                    {format(new Date(session.startedAt), 'MMM d, yyyy')}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {format(new Date(session.startedAt), getTimeFormatString())}
                  </div>
                </div>
              </div>
            </TableCell>
          )}

          {/* User */}
          {columnVisibility.user && (
            <TableCell className={COLUMN_WIDTHS.user}>
              <Link
                to={`/users/${session.serverUserId}`}
                onClick={(e) => e.stopPropagation()}
                className="flex items-center gap-2 hover:underline"
              >
                <Avatar className="h-6 w-6">
                  <AvatarImage
                    src={getAvatarUrl(session.serverId, session.user.thumbUrl, 24) ?? undefined}
                  />
                  <AvatarFallback className="text-xs">
                    {(session.user.identityName ?? session.user.username)?.[0]?.toUpperCase() ??
                      '?'}
                  </AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <span className="block truncate text-sm">
                    {session.user.identityName ?? session.user.username}
                  </span>
                  {session.user.identityName &&
                    session.user.identityName !== session.user.username && (
                      <span className="text-muted-foreground block truncate text-xs">
                        @{session.user.username}
                      </span>
                    )}
                </div>
              </Link>
            </TableCell>
          )}

          {/* Content */}
          {columnVisibility.content && (
            <TableCell className={COLUMN_WIDTHS.content}>
              <div className="flex items-center gap-2">
                <MediaTypeIcon type={session.mediaType} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate font-medium">
                      <MediaPageLink to={mediaLinks.title}>{primary}</MediaPageLink>
                    </span>
                    <EngagementTierBadge progress={progress} state={session.state} />
                  </div>
                  {secondary && (
                    <div className="text-muted-foreground truncate text-xs">
                      <MediaPageLink to={mediaLinks.subtitle}>{secondary}</MediaPageLink>
                    </div>
                  )}
                </div>
              </div>
            </TableCell>
          )}

          {/* Server - only rendered in multi-server mode */}
          {isMultiServer && columnVisibility.server && (
            <TableCell className={COLUMN_WIDTHS.server}>
              <ServerColumnCell server={session.server} />
            </TableCell>
          )}

          {/* Platform/Device */}
          {columnVisibility.platform && (
            <TableCell className={COLUMN_WIDTHS.platform}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div>
                    <div className="truncate text-sm">{session.platform ?? '—'}</div>
                    {session.product && (
                      <div className="text-muted-foreground truncate text-xs">
                        {session.product}
                      </div>
                    )}
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="space-y-1 text-xs">
                    {session.platform && <div>Platform: {session.platform}</div>}
                    {session.product && <div>Product: {session.product}</div>}
                    {session.device && <div>Device: {session.device}</div>}
                    {session.playerName && <div>Player: {session.playerName}</div>}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TableCell>
          )}

          {/* Location */}
          {columnVisibility.location && (
            <TableCell className={COLUMN_WIDTHS.location}>
              {session.geoCity || session.geoCountry ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-1.5">
                      <Globe className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                      <span className="truncate text-sm">
                        {formatLocationCompact(
                          session.geoCity,
                          session.geoRegion,
                          session.geoCountry
                        )}
                      </span>
                      <LocalBadge isLocal={session.isLocal} country={session.geoCountry} />
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    <div className="space-y-1 text-xs">
                      {session.geoCity && <div>City: {session.geoCity}</div>}
                      {session.geoRegion && <div>Region: {session.geoRegion}</div>}
                      {session.geoCountry && (
                        <div>Country: {getCountryName(session.geoCountry)}</div>
                      )}
                      {session.ipAddress && <div>IP: {session.ipAddress}</div>}
                    </div>
                  </TooltipContent>
                </Tooltip>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
          )}

          {/* IP Address */}
          {columnVisibility.ip && (
            <TableCell className={COLUMN_WIDTHS.ip}>
              <span className="text-muted-foreground font-mono text-xs">
                {session.ipAddress || '—'}
              </span>
            </TableCell>
          )}

          {/* Quality */}
          {columnVisibility.quality && (
            <TableCell className={COLUMN_WIDTHS.quality}>
              {(() => {
                const { decision, Icon, variant, isBurnIn } = playbackBadge(session);
                return (
                  <div className="flex items-center gap-1">
                    <Badge variant={variant} className="gap-1 text-xs">
                      <Icon className="h-3 w-3" />
                      {t(PLAYBACK_DECISION_LABEL_KEYS[decision])}
                    </Badge>
                    {isBurnIn && (
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="warning"
                            className="px-1.5 text-xs"
                            aria-label={t('playback.burnIn')}
                          >
                            <Subtitles className="h-3 w-3" />
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent>{t('playback.burnIn')}</TooltipContent>
                      </Tooltip>
                    )}
                  </div>
                );
              })()}
            </TableCell>
          )}

          {/* Duration */}
          {columnVisibility.duration && (
            <TableCell className={COLUMN_WIDTHS.duration}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5">
                    <Clock className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    <span className="text-sm">
                      {formatDuration(session.durationMs, { style: 'compact' })}
                    </span>
                  </div>
                </TooltipTrigger>
                <TooltipContent>
                  <div className="space-y-1 text-xs">
                    <div>
                      Watch time: {formatDuration(session.durationMs, { style: 'compact' })}
                    </div>
                    {session.pausedDurationMs > 0 && (
                      <div>
                        Paused: {formatDuration(session.pausedDurationMs, { style: 'compact' })}
                      </div>
                    )}
                    {session.totalDurationMs && (
                      <div>
                        Media length:{' '}
                        {formatDuration(session.totalDurationMs, { style: 'compact' })}
                      </div>
                    )}
                    {session.segmentCount && session.segmentCount > 1 && (
                      <div>Segments: {session.segmentCount}</div>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </TableCell>
          )}

          {/* Progress */}
          {columnVisibility.progress && (
            <TableCell className={COLUMN_WIDTHS.progress}>
              {progress !== null && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className="flex items-center gap-2">
                      <Progress value={progress} className="h-1.5 w-12" />
                      <span className="text-muted-foreground text-xs">{progress}%</span>
                    </div>
                  </TooltipTrigger>
                  <TooltipContent>
                    {progress}% complete
                    {session.watched && ' (watched)'}
                  </TooltipContent>
                </Tooltip>
              )}
            </TableCell>
          )}
        </TableRow>
      );
    }
  )
);
HistoryTableRow.displayName = 'HistoryTableRow';

// Loading skeleton row with column visibility support
function SkeletonRow({
  columnVisibility,
  isMultiServer = false,
}: {
  columnVisibility: ColumnVisibility;
  isMultiServer?: boolean;
}) {
  return (
    <TableRow style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}>
      {columnVisibility.date && (
        <TableCell>
          <div className="flex items-center gap-2">
            <Skeleton className="h-4 w-4 rounded-full" />
            <div className="space-y-1">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-3 w-14" />
            </div>
          </div>
        </TableCell>
      )}
      {columnVisibility.user && (
        <TableCell>
          <div className="flex items-center gap-2">
            <Skeleton className="h-6 w-6 rounded-full" />
            <Skeleton className="h-4 w-20" />
          </div>
        </TableCell>
      )}
      {columnVisibility.content && (
        <TableCell>
          <div className="space-y-1">
            <Skeleton className="h-4 w-36" />
            <Skeleton className="h-3 w-24" />
          </div>
        </TableCell>
      )}
      {isMultiServer && columnVisibility.server && (
        <TableCell>
          <Skeleton className="h-5 w-24 rounded-full" />
        </TableCell>
      )}
      {columnVisibility.platform && (
        <TableCell>
          <div className="space-y-1">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-3 w-20" />
          </div>
        </TableCell>
      )}
      {columnVisibility.location && (
        <TableCell>
          <Skeleton className="h-4 w-20" />
        </TableCell>
      )}
      {columnVisibility.ip && (
        <TableCell>
          <Skeleton className="h-4 w-24" />
        </TableCell>
      )}
      {columnVisibility.quality && (
        <TableCell>
          <Skeleton className="h-5 w-20 rounded-full" />
        </TableCell>
      )}
      {columnVisibility.duration && (
        <TableCell>
          <Skeleton className="h-4 w-14" />
        </TableCell>
      )}
      {columnVisibility.progress && (
        <TableCell>
          <div className="flex items-center gap-2">
            <Skeleton className="h-1.5 w-12" />
            <Skeleton className="h-3 w-8" />
          </div>
        </TableCell>
      )}
    </TableRow>
  );
}

// Count visible columns for empty state colspan
const COLUMN_WIDTHS = {
  date: 'w-[140px]',
  user: 'w-[150px]',
  content: 'w-[280px]',
  server: 'w-[150px]',
  platform: 'w-[130px]',
  location: 'w-[170px]',
  ip: 'w-[130px]',
  quality: 'w-[140px]',
  duration: 'w-[100px]',
  progress: 'w-[110px]',
} as const;

function getVisibleColumnCount(columnVisibility: ColumnVisibility, isMultiServer: boolean): number {
  return Object.entries(columnVisibility).filter(
    ([key, visible]) => visible && (key !== 'server' || isMultiServer)
  ).length;
}

// Sortable header component
export function HistoryTable({
  sessions,
  isLoading,
  isFetching,
  isFetchingNextPage,
  hasNextPage,
  onLoadMore,
  onSessionClick,
  columnVisibility,
  sortBy,
  sortDir,
  onSortChange,
  isMultiServer = false,
}: Props) {
  const visibleColumnCount = getVisibleColumnCount(columnVisibility, isMultiServer);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const rowVirtualizer = useVirtualizer({
    count: sessions.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => 53,
    overscan: 10,
  });

  // Trigger load more when user scrolls near the end of the list
  useEffect(() => {
    const scrollEl = scrollContainerRef.current;
    if (!scrollEl || !hasNextPage || isFetchingNextPage || !onLoadMore) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = scrollEl;
      // Load more when within 200px of the bottom
      if (scrollHeight - scrollTop - clientHeight < 200) {
        onLoadMore();
      }
    };

    scrollEl.addEventListener('scroll', handleScroll, { passive: true });
    return () => scrollEl.removeEventListener('scroll', handleScroll);
  }, [hasNextPage, isFetchingNextPage, onLoadMore]);

  // Initial loading state: render full-width table with skeleton rows (no virtualizer needed)
  if (isLoading) {
    return (
      <div
        className="relative scrollbar-thin overflow-auto"
        style={{ maxHeight: DATA_TABLE_VIEWPORT_MAX_HEIGHT }}
      >
        <table className="w-full min-w-[1070px] table-fixed caption-bottom text-sm">
          <thead
            className="bg-card sticky top-0 z-10 [&_tr]:border-b"
            style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}
          >
            <tr>
              {columnVisibility.date && <TableHead className={COLUMN_WIDTHS.date}>Date</TableHead>}
              {columnVisibility.user && <TableHead className={COLUMN_WIDTHS.user}>User</TableHead>}
              {columnVisibility.content && (
                <TableHead className={COLUMN_WIDTHS.content}>Content</TableHead>
              )}
              {isMultiServer && columnVisibility.server && (
                <TableHead className={COLUMN_WIDTHS.server}>Server</TableHead>
              )}
              {columnVisibility.platform && (
                <TableHead className={COLUMN_WIDTHS.platform}>Platform</TableHead>
              )}
              {columnVisibility.location && (
                <TableHead className={COLUMN_WIDTHS.location}>Location</TableHead>
              )}
              {columnVisibility.ip && (
                <TableHead className={COLUMN_WIDTHS.ip}>IP Address</TableHead>
              )}
              {columnVisibility.quality && (
                <TableHead className={COLUMN_WIDTHS.quality}>Quality</TableHead>
              )}
              {columnVisibility.duration && (
                <TableHead className={COLUMN_WIDTHS.duration}>Duration</TableHead>
              )}
              {columnVisibility.progress && (
                <TableHead className={COLUMN_WIDTHS.progress}>Progress</TableHead>
              )}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: 10 }).map((_, i) => (
              <SkeletonRow
                key={i}
                columnVisibility={columnVisibility}
                isMultiServer={isMultiServer}
              />
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  // Empty state
  if (sessions.length === 0) {
    return (
      <div
        className="relative scrollbar-thin overflow-auto"
        style={{ maxHeight: DATA_TABLE_VIEWPORT_MAX_HEIGHT }}
      >
        <table className="w-full min-w-[1070px] table-fixed caption-bottom text-sm">
          <thead
            className="bg-card sticky top-0 z-10 [&_tr]:border-b"
            style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}
          >
            <tr>
              {columnVisibility.date && <TableHead className={COLUMN_WIDTHS.date}>Date</TableHead>}
              {columnVisibility.user && <TableHead className={COLUMN_WIDTHS.user}>User</TableHead>}
              {columnVisibility.content && (
                <TableHead className={COLUMN_WIDTHS.content}>Content</TableHead>
              )}
              {isMultiServer && columnVisibility.server && (
                <TableHead className={COLUMN_WIDTHS.server}>Server</TableHead>
              )}
              {columnVisibility.platform && (
                <TableHead className={COLUMN_WIDTHS.platform}>Platform</TableHead>
              )}
              {columnVisibility.location && (
                <TableHead className={COLUMN_WIDTHS.location}>Location</TableHead>
              )}
              {columnVisibility.ip && (
                <TableHead className={COLUMN_WIDTHS.ip}>IP Address</TableHead>
              )}
              {columnVisibility.quality && (
                <TableHead className={COLUMN_WIDTHS.quality}>Quality</TableHead>
              )}
              {columnVisibility.duration && (
                <TableHead className={COLUMN_WIDTHS.duration}>Duration</TableHead>
              )}
              {columnVisibility.progress && (
                <TableHead className={COLUMN_WIDTHS.progress}>Progress</TableHead>
              )}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td colSpan={visibleColumnCount} className="h-32 text-center">
                <div className="text-muted-foreground flex flex-col items-center gap-2">
                  <Clock className="h-8 w-8" />
                  <p>No sessions found</p>
                  <p className="text-sm">Try adjusting your filters</p>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div
      ref={scrollContainerRef}
      className={cn(
        'relative scrollbar-thin overflow-auto transition-opacity',
        isFetching && !isLoading && 'opacity-60'
      )}
      style={{ maxHeight: DATA_TABLE_VIEWPORT_MAX_HEIGHT }}
    >
      <table className="w-full min-w-[1070px] table-fixed caption-bottom text-sm">
        <thead
          className="bg-card sticky top-0 z-10 [&_tr]:border-b"
          style={{ display: 'table', width: '100%', tableLayout: 'fixed' }}
        >
          <tr>
            {columnVisibility.date && (
              <SortableTableHead
                className={COLUMN_WIDTHS.date}
                field="startedAt"
                sortBy={sortBy}
                sortOrder={sortDir}
                onSort={(next) => onSortChange?.(next)}
              >
                Date
              </SortableTableHead>
            )}
            {columnVisibility.user && <TableHead className={COLUMN_WIDTHS.user}>User</TableHead>}
            {columnVisibility.content && (
              <SortableTableHead
                className={COLUMN_WIDTHS.content}
                field="mediaTitle"
                sortBy={sortBy}
                sortOrder={sortDir}
                onSort={(next) => onSortChange?.(next)}
              >
                Content
              </SortableTableHead>
            )}
            {isMultiServer && columnVisibility.server && (
              <TableHead className={COLUMN_WIDTHS.server}>Server</TableHead>
            )}
            {columnVisibility.platform && (
              <TableHead className={COLUMN_WIDTHS.platform}>Platform</TableHead>
            )}
            {columnVisibility.location && (
              <TableHead className={COLUMN_WIDTHS.location}>Location</TableHead>
            )}
            {columnVisibility.ip && <TableHead className={COLUMN_WIDTHS.ip}>IP Address</TableHead>}
            {columnVisibility.quality && (
              <TableHead className={COLUMN_WIDTHS.quality}>Quality</TableHead>
            )}
            {columnVisibility.duration && (
              <SortableTableHead
                className={COLUMN_WIDTHS.duration}
                field="durationMs"
                sortBy={sortBy}
                sortOrder={sortDir}
                onSort={(next) => onSortChange?.(next)}
              >
                Duration
              </SortableTableHead>
            )}
            {columnVisibility.progress && (
              <TableHead className={COLUMN_WIDTHS.progress}>Progress</TableHead>
            )}
          </tr>
        </thead>
        <tbody
          style={{
            height: `${rowVirtualizer.getTotalSize()}px`,
            position: 'relative',
            display: 'block',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const session = sessions[virtualRow.index];
            if (!session) return null;
            return (
              <HistoryTableRow
                key={session.id}
                data-index={virtualRow.index}
                ref={rowVirtualizer.measureElement}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  transform: `translateY(${virtualRow.start}px)`,
                  display: 'table',
                  tableLayout: 'fixed',
                }}
                session={session}
                onClick={onSessionClick ? () => onSessionClick(session) : undefined}
                columnVisibility={columnVisibility}
                isMultiServer={isMultiServer}
              />
            );
          })}
        </tbody>
      </table>

      {/* Skeleton rows shown while fetching next page, rendered below the virtual table */}
      {isFetchingNextPage && (
        <table className="w-full caption-bottom text-sm" style={{ tableLayout: 'fixed' }}>
          <tbody>
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonRow
                key={`loading-${i}`}
                columnVisibility={columnVisibility}
                isMultiServer={isMultiServer}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
