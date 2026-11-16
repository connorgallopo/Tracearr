import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';
import type { MediaWatcherEntry } from '@tracearr/shared';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineErrorState } from '@/components/library/ErrorState';
import { formatCompactAge } from '@/lib/dateFormat';
import { formatNumber } from '@/components/ui/stat-card';
import { getAvatarUrl } from '@/components/users/utils';

interface WatchersTableProps {
  watchers: MediaWatcherEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  mediaType: string | undefined;
  episodeCount: number | null | undefined;
}

function WatchersTableSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-[22px] w-[22px] shrink-0 rounded-full" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-10" />
        </div>
      ))}
    </div>
  );
}

export function WatchersTable({
  watchers,
  isLoading,
  isError,
  onRetry,
  mediaType,
  episodeCount,
}: WatchersTableProps) {
  const { t } = useTranslation(['pages', 'common']);
  const showEpisodes = mediaType === 'show';
  const isArtist = mediaType === 'artist';
  const title = t(isArtist ? 'media.detail.watchers.titleMusic' : 'media.detail.watchers.title');

  return (
    <section aria-labelledby="watchers-heading" className="bg-card rounded-xl border p-6 shadow-sm">
      <h2 id="watchers-heading" className="mb-3 text-base font-semibold">
        {title}
      </h2>

      {isError ? (
        <InlineErrorState message={t('media.detail.watchers.loadError')} onRetry={onRetry} />
      ) : isLoading || watchers === undefined ? (
        <WatchersTableSkeleton />
      ) : watchers.length === 0 ? (
        <EmptyState
          title={t(isArtist ? 'media.detail.watchers.emptyMusic' : 'media.detail.watchers.empty')}
          className="py-6"
        />
      ) : (
        <div className="overflow-x-auto">
          <Table aria-label={title}>
            <TableCaption className="sr-only">{title}</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('common:labels.user')}</TableHead>
                <TableHead className="text-right">
                  {t('media.detail.watchers.columns.plays')}
                </TableHead>
                {showEpisodes && (
                  <TableHead className="text-right">
                    {t('media.detail.watchers.columns.episodes')}
                  </TableHead>
                )}
                <TableHead>{t('media.detail.watchers.columns.completion')}</TableHead>
                <TableHead className="text-right">
                  {t(
                    isArtist
                      ? 'media.detail.watchers.columns.lastPlayed'
                      : 'media.detail.watchers.columns.lastWatched'
                  )}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {watchers.map((watcher) => {
                const name = watcher.user.identityName ?? watcher.user.username ?? '?';
                const pct =
                  watcher.completionPct != null ? Math.round(watcher.completionPct) : null;
                return (
                  <TableRow key={watcher.user.serverUserId}>
                    <TableCell>
                      {(() => {
                        const cell = (
                          <>
                            <Avatar className="h-[22px] w-[22px] shrink-0">
                              <AvatarImage
                                src={
                                  getAvatarUrl(
                                    watcher.user.thumbServerId,
                                    watcher.user.thumb,
                                    22
                                  ) ?? undefined
                                }
                              />
                              <AvatarFallback className="text-xs">
                                {name[0]?.toUpperCase() ?? '?'}
                              </AvatarFallback>
                            </Avatar>
                            <span className="truncate">{name}</span>
                          </>
                        );
                        return watcher.user.serverUserId ? (
                          <Link
                            to={`/users/${watcher.user.serverUserId}`}
                            className="flex items-center gap-2 font-medium hover:underline"
                          >
                            {cell}
                          </Link>
                        ) : (
                          <div className="flex items-center gap-2 font-medium">{cell}</div>
                        );
                      })()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatNumber(watcher.plays)}
                    </TableCell>
                    {showEpisodes && (
                      <TableCell className="text-right tabular-nums">
                        {watcher.distinctEpisodesWatched ?? 0}
                        {episodeCount != null ? ` / ${episodeCount}` : ''}
                      </TableCell>
                    )}
                    <TableCell>
                      {pct != null ? (
                        <div
                          role="progressbar"
                          aria-label={t('media.detail.watchers.completionLabel', { percent: pct })}
                          aria-valuenow={Math.max(0, Math.min(100, pct))}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          className="bg-muted h-[5px] w-[110px] overflow-hidden rounded-full"
                        >
                          <div
                            className="bg-primary h-full rounded-full"
                            style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
                          />
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right">
                      {watcher.lastWatchedDay
                        ? t('media.detail.watchers.lastWatchedAgo', {
                            age: formatCompactAge(watcher.lastWatchedDay),
                          })
                        : '—'}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
