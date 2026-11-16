import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Layers, Library, Play } from 'lucide-react';
import type { GenreDetailResponse, GenreTitle, LibraryMediaType } from '@tracearr/shared';
import { HourStrip, peakHourOf } from '@/components/charts/HourStrip';
import { formatHourOfDay } from '@/lib/dateFormat';
import { PlaysChart, priorRangeComparison } from '@/components/charts/PlaysChart';
import { InlineErrorState } from '@/components/library/ErrorState';
import { PosterThumb } from '@/components/media-browse/PosterThumb';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { StatCard } from '@/components/ui/stat-card';
import { UserCell } from '@/components/users/UserCell';
import { useGenreDetail } from '@/hooks/queries';
import { browseHref } from '@/lib/browseLinks';
import { formatBytes, formatNumber, formatPercent } from '@/lib/formatters';
import { deltaPercent } from '@/lib/periodWindows';
import type { StatsTimeRange } from '@/lib/api';

function percentOrDash(value: number | null, decimals?: number): string {
  return value === null ? '—' : formatPercent(value, decimals);
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function TitleList({
  titles,
  linked,
  detail,
}: {
  titles: GenreTitle[];
  linked: boolean;
  detail: (title: GenreTitle) => string;
}) {
  return (
    <ul className="space-y-1">
      {titles.map((title) => {
        const body = (
          <>
            <PosterThumb serverId={title.serverId} thumbPath={title.thumbPath} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">
                {title.title}
                {title.year !== null && (
                  <span className="text-muted-foreground font-normal"> ({title.year})</span>
                )}
              </span>
              <span className="text-muted-foreground block text-xs">{detail(title)}</span>
            </span>
          </>
        );
        return (
          <li key={title.mediaId}>
            {linked ? (
              <Link
                to={`/media/${title.mediaId}`}
                className="hover:bg-muted/50 flex items-center gap-3 rounded-md p-1 transition-colors"
              >
                {body}
              </Link>
            ) : (
              <div className="flex items-center gap-3 p-1">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function GenreDetailBody({
  detail,
  type,
  period,
  comparePeakHour,
}: {
  detail: GenreDetailResponse;
  type: LibraryMediaType;
  period: StatsTimeRange['period'];
  comparePeakHour: number | null;
}) {
  const { t } = useTranslation(['pages', 'common']);
  const { kpis } = detail;
  const playsDelta = deltaPercent(kpis.plays, kpis.priorPlays);
  const peakHour = peakHourOf(detail.hourly);
  const artist = type === 'artist';
  // Artists have no media row, so their ids are not /media/:id targets.
  const linked = !artist;
  const itemCount = artist
    ? t('pages:media.genres.sheet.artistCount', { count: kpis.itemCount })
    : t('pages:media.genres.chart.itemCount', { count: kpis.itemCount });

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          compact
          icon={Play}
          label={t('common:labels.plays')}
          value={formatNumber(kpis.plays)}
          delta={
            playsDelta === null
              ? undefined
              : { value: playsDelta, label: t('pages:userDetail.cards.vsPrior') }
          }
          subValue={t(`pages:media.landing.shelves.captionMostPopular.${period}`)}
        />
        <StatCard
          compact
          icon={CheckCircle2}
          label={t('pages:userDetail.cards.finished')}
          value={percentOrDash(kpis.finishedRate, 0)}
          subValue={
            kpis.abandonedRate === null
              ? t('pages:media.detail.album.finishedCaption')
              : t('pages:userDetail.cards.abandoned', { value: Math.round(kpis.abandonedRate) })
          }
        />
        <StatCard
          compact
          icon={Library}
          label={t('pages:media.genres.share.items')}
          value={percentOrDash(kpis.itemShare)}
          subValue={`${itemCount} · ${formatBytes(kpis.sizeBytes)}`}
        />
        <StatCard
          compact
          icon={Layers}
          label={t('pages:media.genres.share.plays')}
          value={percentOrDash(kpis.playShare)}
          subValue={t('pages:media.genres.sheet.ofCountedPlays')}
        />
      </div>

      <Section title={t('pages:userDetail.overview.playsOverTime')}>
        <PlaysChart
          data={detail.weekly}
          period="all"
          height={180}
          comparisons={
            detail.priorWeekly.length > 0
              ? [
                  priorRangeComparison(
                    t('pages:userDetail.overview.priorRange'),
                    detail.priorWeekly,
                    detail.weekly
                  ),
                ]
              : []
          }
        />
      </Section>

      <Section title={t('pages:userDetail.overview.byHour')}>
        <HourStrip
          data={detail.hourly}
          peakHour={peakHour}
          peakLabel={
            peakHour === null
              ? undefined
              : t('pages:userDetail.overview.peak', { hour: formatHourOfDay(peakHour) })
          }
          comparePeakLabel={
            comparePeakHour === null
              ? undefined
              : t('pages:media.genres.sheet.allGenresPeak', {
                  hour: formatHourOfDay(comparePeakHour),
                })
          }
          label={t('pages:userDetail.overview.byHour')}
        />
      </Section>

      {detail.topViewers.length > 0 && (
        <Section title={t('pages:media.genres.sheet.whoPlays')}>
          <ul className="space-y-2">
            {detail.topViewers.map((viewer) => (
              <li key={viewer.userId} className="flex items-center justify-between gap-3">
                <UserCell
                  serverUserId={viewer.serverUserId}
                  username={viewer.name}
                  identityName={viewer.name}
                  thumbUrl={viewer.thumbUrl}
                  serverId={viewer.serverId}
                />
                <span className="text-muted-foreground text-sm tabular-nums">
                  {formatPercent(viewer.share, 0)}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {detail.topTitles.length > 0 && (
        <Section
          title={t(
            artist ? 'pages:media.genres.sheet.topArtists' : 'pages:media.genres.sheet.topTitles'
          )}
        >
          <TitleList
            titles={detail.topTitles}
            linked={linked}
            detail={(title) => t('common:count.play', { count: title.plays })}
          />
        </Section>
      )}

      {detail.neverPlayed.length > 0 && (
        <Section title={t('pages:requests.page.kpi.neverPlayed')}>
          <TitleList
            titles={detail.neverPlayed}
            linked={linked}
            detail={(title) => formatBytes(title.sizeBytes)}
          />
        </Section>
      )}
    </>
  );
}

interface GenreSheetProps {
  genre: string | null;
  type: LibraryMediaType;
  serverIds: string[];
  timeRange: StatsTimeRange;
  /** The all-genres peak the genre's own is read against. */
  comparePeakHour: number | null;
  onClose: () => void;
}

export function GenreSheet({
  genre,
  type,
  serverIds,
  timeRange,
  comparePeakHour,
  onClose,
}: GenreSheetProps) {
  const { t } = useTranslation(['pages', 'common']);
  const { data, isLoading, isError, refetch } = useGenreDetail(
    genre ?? '',
    type,
    serverIds,
    timeRange,
    { enabled: genre !== null }
  );

  return (
    <Sheet open={genre !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{genre}</SheetTitle>
          <SheetDescription>{t('pages:media.genres.sheet.description')}</SheetDescription>
        </SheetHeader>
        <div className="space-y-6 px-4">
          {isError ? (
            <InlineErrorState
              message={t('pages:media.genres.loadError')}
              onRetry={() => void refetch()}
            />
          ) : isLoading || !data ? (
            <div className="grid grid-cols-2 gap-3" aria-busy="true">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-20" />
              ))}
            </div>
          ) : (
            <GenreDetailBody
              detail={data}
              type={type}
              period={timeRange.period}
              comparePeakHour={comparePeakHour}
            />
          )}
        </div>
        {genre !== null && (
          <SheetFooter>
            <Button asChild variant="outline">
              <Link to={browseHref(type, { genre })}>{t('pages:media.genres.sheet.browse')}</Link>
            </Button>
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
