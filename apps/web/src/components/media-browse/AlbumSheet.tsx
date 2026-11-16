import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Clock, Play, Users } from 'lucide-react';
import { verbKeysFor, type AlbumDetailResponse, type AlbumTrack } from '@tracearr/shared';
import { InlineErrorState } from '@/components/library/ErrorState';
import {
  createDataTableColumnHelper,
  DataTableBody,
  DataTableHeader,
  DataTableRoot,
  DataTableViewport,
  useDataTable,
} from '@/components/ui/data-table';
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
import { useAlbumDetail } from '@/hooks/queries';
import { formatNumber, formatPercent } from '@/lib/formatters';
import { deltaPercent } from '@/lib/periodWindows';
import { cn } from '@/lib/utils';
import { formatDate, formatUtcDay, formatWatchTime } from '@/lib/dateFormat';
import { OpenOnServerAction, openOnServerTargets, type HeroServerLookupEntry } from './DetailHero';
import { buildPosterSrc, PosterArt } from './PosterCard';

const columnHelper = createDataTableColumnHelper<AlbumTrack>();

const getRowId = (track: AlbumTrack) => `${track.index ?? ''}:${track.title.toLowerCase()}`;

function muted(track: AlbumTrack) {
  return track.plays === 0 ? 'text-muted-foreground' : undefined;
}

function TrackTable({ tracks }: { tracks: AlbumTrack[] }) {
  const { t } = useTranslation(['pages', 'common']);
  const hasLengths = tracks.some((track) => track.durationMs !== null);

  const columns = useMemo(
    () =>
      columnHelper.columns([
        columnHelper.accessor((track) => track.index ?? Infinity, {
          id: 'index',
          header: '#',
          enableSorting: false,
          meta: { numeric: true, width: '1%', cellClassName: 'text-muted-foreground' },
          cell: ({ row }) => row.original.index ?? '—',
        }),
        columnHelper.accessor('title', {
          header: t('pages:media.detail.album.columns.title'),
          enableSorting: false,
          meta: { cellClassName: 'w-full max-w-0' },
          cell: ({ row }) => (
            <span className={cn('block truncate', muted(row.original))} title={row.original.title}>
              {row.original.title}
            </span>
          ),
        }),
        ...(hasLengths
          ? [
              columnHelper.accessor((track) => track.durationMs ?? -1, {
                id: 'length',
                header: t('pages:media.detail.album.columns.length'),
                enableSorting: false,
                meta: { numeric: true, width: '4.5rem', cellClassName: 'text-muted-foreground' },
                cell: ({ row }) => {
                  const ms = row.original.durationMs;
                  return ms === null ? '—' : formatWatchTime(ms);
                },
              }),
            ]
          : []),
        columnHelper.accessor('plays', {
          header: t('common:labels.plays'),
          enableSorting: false,
          meta: { numeric: true, width: '4rem' },
          cell: ({ row }) =>
            row.original.plays === 0 ? (
              <span className="text-muted-foreground">—</span>
            ) : (
              formatNumber(row.original.plays)
            ),
        }),
        columnHelper.accessor((track) => track.lastPlayedAt ?? '', {
          id: 'lastPlayed',
          header: t('pages:media.detail.watchers.columns.lastPlayed'),
          enableSorting: false,
          meta: { numeric: true, width: '6.5rem', cellClassName: 'text-muted-foreground' },
          cell: ({ row }) => {
            const day = row.original.lastPlayedAt;
            return day ? formatUtcDay(day) : '—';
          },
        }),
      ]),
    [t, hasLengths]
  );

  const { table } = useDataTable<AlbumTrack>({
    columns,
    data: tracks,
    getRowId,
    pageSize: Math.max(tracks.length, 1),
  });

  return (
    <DataTableRoot density="compact" headerVariant="micro">
      <DataTableViewport className="rounded-lg border">
        <DataTableHeader table={table} />
        <DataTableBody table={table} />
      </DataTableViewport>
    </DataTableRoot>
  );
}

function AlbumBody({ detail, isMember }: { detail: AlbumDetailResponse; isMember: boolean }) {
  const { t } = useTranslation(['pages', 'common']);
  const { last30, allTime } = detail;
  const playsDelta = deltaPercent(last30.plays, last30.priorPlays);
  const showListeners = !isMember || allTime.listeners.length > 0;
  const last30Caption = t('pages:media.landing.shelves.captionMostPopular.month');
  const topListeners = allTime.listeners
    .slice(0, 2)
    .map((listener) => `${listener.name} ${formatPercent(listener.share, 0)}`)
    .join(' · ');

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <StatCard
          compact
          icon={Play}
          label={t('common:labels.plays')}
          value={formatNumber(last30.plays)}
          delta={playsDelta === null ? undefined : { value: playsDelta }}
          subValue={playsDelta === null ? last30Caption : t('pages:media.detail.album.vsPrior30')}
        />
        <StatCard
          compact
          icon={Clock}
          label={t(verbKeysFor('album').watchTime)}
          value={formatWatchTime(last30.listenMs)}
          subValue={last30Caption}
        />
        {showListeners && (
          <StatCard
            compact
            icon={Users}
            label={t('pages:media.detail.watchers.titleMusic')}
            value={formatNumber(allTime.listeners.length)}
            subValue={topListeners || t('pages:media.landing.shelves.captionMostPopular.all')}
          />
        )}
        <StatCard
          compact
          icon={CheckCircle2}
          label={t('pages:userDetail.cards.finished')}
          value={allTime.finishedRate === null ? '—' : formatPercent(allTime.finishedRate, 0)}
          subValue={t('pages:media.detail.album.finishedCaption')}
        />
      </div>

      <section className="space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-sm font-semibold">{t('common:media.track_plural')}</h3>
          <span className="text-muted-foreground text-xs">
            {t('pages:media.detail.album.tracksCaption')}
          </span>
        </div>
        <TrackTable tracks={detail.tracks} />
      </section>
    </>
  );
}

interface AlbumSheetProps {
  albumId: string | null;
  serverIds: string[];
  serverById: Map<string, HeroServerLookupEntry>;
  isMember: boolean;
  onClose: () => void;
}

export function AlbumSheet({ albumId, serverIds, serverById, isMember, onClose }: AlbumSheetProps) {
  const { t } = useTranslation(['pages', 'common']);
  const { data, isLoading, isError, refetch } = useAlbumDetail(
    albumId ?? '',
    serverIds,
    albumId !== null
  );
  const album = data?.album;
  const serverTargets = album ? openOnServerTargets(album.copies, serverById) : [];
  const kind = t('pages:media.detail.album.kind');

  return (
    <Sheet open={albumId !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <div className="flex items-start gap-3.5 pr-6">
            <div className="bg-muted size-[72px] shrink-0 overflow-hidden rounded-lg">
              {album && (
                <PosterArt
                  src={
                    album.posterUrl
                      ? buildPosterSrc(album.posterUrl, album.posterVersion, { square: true })
                      : null
                  }
                  title={album.title}
                  dominantColor={null}
                  caption={false}
                />
              )}
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-muted-foreground text-xs tracking-wide uppercase">
                {[kind, album?.artistTitle, album?.year?.toString()].filter(Boolean).join(' · ')}
              </p>
              <SheetTitle className="text-xl leading-tight">{album?.title ?? kind}</SheetTitle>
              <SheetDescription className={cn('text-xs', !album && 'sr-only')}>
                {album
                  ? [
                      t('pages:media.detail.albums.trackCount', { count: album.trackCount }),
                      album.durationMs === null ? null : formatWatchTime(album.durationMs),
                      t('pages:media.detail.hero.availability.added', {
                        date: formatDate(new Date(album.addedAt), { dateStyle: 'medium' }),
                      }),
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : kind}
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>
        <div className="space-y-5 px-4">
          {isError ? (
            <InlineErrorState
              message={t('pages:media.detail.album.loadError')}
              onRetry={() => void refetch()}
            />
          ) : isLoading || !data ? (
            <div className="grid grid-cols-2 gap-2" aria-busy="true">
              {Array.from({ length: 4 }, (_, index) => (
                <Skeleton key={index} className="h-20" />
              ))}
            </div>
          ) : (
            <AlbumBody detail={data} isMember={isMember} />
          )}
        </div>
        {serverTargets.length > 0 && (
          <SheetFooter>
            <OpenOnServerAction targets={serverTargets} />
          </SheetFooter>
        )}
      </SheetContent>
    </Sheet>
  );
}
