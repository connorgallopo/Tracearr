import { useTranslation } from 'react-i18next';
import { Calendar, CheckCircle2, Clock, Play, Users } from 'lucide-react';
import { verbKeysFor, type MediaStatsResponse, type MediaWatcherEntry } from '@tracearr/shared';
import { formatIsoDay, formatKpiHours } from '@/lib/dateFormat';
import { StatCard, formatNumber } from '@/components/ui/stat-card';
import { InlineErrorState } from '@/components/library/ErrorState';

interface KpiStripProps {
  mediaType: string | undefined;
  stats: MediaStatsResponse | undefined;
  statsLoading: boolean;
  statsError: boolean;
  onRetryStats: () => void;
  watchers: MediaWatcherEntry[] | undefined;
  watchersLoading: boolean;
  watchersError: boolean;
  onRetryWatchers: () => void;
}

/** Mean of the watchers' non-null completionPct values, rounded; null when nobody has a completion figure yet. */
export function averageCompletion(watchers: MediaWatcherEntry[]): number | null {
  const values = watchers.map((w) => w.completionPct).filter((p): p is number => p != null);
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function finishedEveryEpisodeCount(watchers: MediaWatcherEntry[]): number {
  return watchers.filter((w) => w.completionPct === 100).length;
}

export function KpiStrip({
  mediaType,
  stats,
  statsLoading,
  statsError,
  onRetryStats,
  watchers,
  watchersLoading,
  watchersError,
  onRetryWatchers,
}: KpiStripProps) {
  const { t } = useTranslation(['pages', 'common']);

  const watcherList = watchers ?? [];
  const avgCompletion = averageCompletion(watcherList);
  const finishedCount = finishedEveryEpisodeCount(watcherList);
  const totalWatchers = watcherList.length;
  const completionDetailKey =
    mediaType === 'movie'
      ? 'media.detail.kpis.completion.detailMovie'
      : mediaType === 'artist'
        ? 'media.detail.kpis.completion.detailMusic'
        : 'media.detail.kpis.completion.detail';

  return (
    <div
      className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3"
      data-testid="detail-kpi-strip"
      aria-label={t('media.detail.kpis.ariaLabel')}
    >
      {statsError ? (
        <div className="col-span-full">
          <InlineErrorState message={t('media.detail.kpis.loadError')} onRetry={onRetryStats} />
        </div>
      ) : statsLoading || !stats ? (
        <>
          <StatCard label="" value="" isLoading />
          <StatCard label="" value="" isLoading />
          <StatCard label="" value="" isLoading />
        </>
      ) : (
        <>
          <StatCard
            icon={Play}
            label={t('media.detail.kpis.plays.label')}
            value={formatNumber(stats.windows.all_time.combined.plays)}
            subValue={t('media.detail.kpis.plays.caption')}
          />
          <StatCard
            icon={Clock}
            label={t(verbKeysFor(mediaType).watchTime)}
            value={formatKpiHours(stats.windows.all_time.combined.watchTimeMs)}
            subValue={t('media.detail.kpis.watchTime.detail', {
              hours: Math.round(stats.windows.last_30.combined.watchTimeMs / 3_600_000),
            })}
          />
          <StatCard
            icon={Users}
            label={t(
              mediaType === 'artist'
                ? 'media.detail.kpis.viewers.labelMusic'
                : 'media.detail.kpis.viewers.label'
            )}
            value={formatNumber(stats.windows.all_time.combined.uniqueUsers)}
            subValue={t('media.detail.kpis.viewers.detail')}
          />
        </>
      )}

      {watchersError ? (
        <div className="col-span-full">
          <InlineErrorState
            message={t('media.detail.kpis.completionLoadError')}
            onRetry={onRetryWatchers}
          />
        </div>
      ) : watchersLoading || watchers === undefined ? (
        <StatCard label="" value="" isLoading />
      ) : (
        <StatCard
          icon={CheckCircle2}
          label={t('media.detail.kpis.completion.label')}
          value={avgCompletion != null ? `${avgCompletion}%` : '—'}
          subValue={t(completionDetailKey, { finished: finishedCount, total: totalWatchers })}
        />
      )}
    </div>
  );
}

interface MemberKpiStripProps {
  mediaType: string | undefined;
  episodeCount: number | null | undefined;
  watchers: MediaWatcherEntry[] | undefined;
  watchersLoading: boolean;
  watchersError: boolean;
  onRetryWatchers: () => void;
  /** Present only when the owner shares anonymous server activity */
  othersCount: number | undefined;
}

/** A member's own numbers for this title; the server leaves every other watcher out. */
export function MemberKpiStrip({
  mediaType,
  episodeCount,
  watchers,
  watchersLoading,
  watchersError,
  onRetryWatchers,
  othersCount,
}: MemberKpiStripProps) {
  const { t } = useTranslation('pages');
  const own = watchers ?? [];
  const plays = own.reduce((sum, w) => sum + w.plays, 0);
  const watchTimeMs = own.reduce((sum, w) => sum + w.watchTimeMs, 0);
  const completion = averageCompletion(own);
  const lastWatchedDay = own.reduce<string | null>(
    (latest, w) =>
      w.lastWatchedDay && (!latest || w.lastWatchedDay > latest) ? w.lastWatchedDay : latest,
    null
  );
  const episodesWatched = Math.max(0, ...own.map((w) => w.distinctEpisodesWatched ?? 0));
  const showEpisodes = mediaType === 'show' && episodesWatched > 0 && !!episodeCount;
  const isArtist = mediaType === 'artist';

  return (
    <div
      className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-3"
      data-testid="detail-kpi-strip"
      aria-label={t('media.detail.kpis.ariaLabel')}
    >
      {watchersError ? (
        <div className="col-span-full">
          <InlineErrorState message={t('media.detail.kpis.loadError')} onRetry={onRetryWatchers} />
        </div>
      ) : watchersLoading || watchers === undefined ? (
        <>
          <StatCard label="" value="" isLoading />
          <StatCard label="" value="" isLoading />
          <StatCard label="" value="" isLoading />
          <StatCard label="" value="" isLoading />
        </>
      ) : (
        <>
          <StatCard
            icon={Play}
            label={t('media.detail.kpis.yourPlays')}
            value={formatNumber(plays)}
          />
          <StatCard
            icon={Clock}
            label={t(
              isArtist ? 'media.detail.kpis.yourListenTime' : 'media.detail.kpis.yourWatchTime'
            )}
            value={formatKpiHours(watchTimeMs)}
          />
          <StatCard
            icon={CheckCircle2}
            label={t('media.detail.kpis.yourCompletion')}
            value={completion != null ? `${completion}%` : '-'}
            subValue={
              showEpisodes
                ? t('media.detail.kpis.episodesOf', {
                    watched: episodesWatched,
                    total: episodeCount,
                  })
                : undefined
            }
          />
          <StatCard
            icon={Calendar}
            label={t(isArtist ? 'media.detail.kpis.lastPlayed' : 'media.detail.kpis.lastWatched')}
            value={lastWatchedDay ? formatIsoDay(lastWatchedDay) : '-'}
          />
        </>
      )}
      {othersCount !== undefined && othersCount > 0 && (
        <p className="text-muted-foreground col-span-full text-xs">
          {t(isArtist ? 'media.detail.kpis.playedByOthers' : 'media.detail.kpis.watchedByOthers', {
            count: othersCount,
          })}
        </p>
      )}
    </div>
  );
}
