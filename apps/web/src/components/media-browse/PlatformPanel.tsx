import { useTranslation } from 'react-i18next';
import { verbKeysFor, type MediaPlatformBreakdownEntry } from '@tracearr/shared';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { InlineErrorState } from '@/components/library/ErrorState';
import { formatDuration } from '@/lib/dateFormat';
import { formatNumber } from '@/components/ui/stat-card';

interface PlatformPanelProps {
  data: MediaPlatformBreakdownEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  mediaType: string | undefined;
}

function PlatformPanelSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-10" />
          <Skeleton className="h-4 w-14" />
        </div>
      ))}
    </div>
  );
}

export function PlatformPanel({
  data,
  isLoading,
  isError,
  onRetry,
  mediaType,
}: PlatformPanelProps) {
  const { t } = useTranslation(['pages', 'common']);

  return (
    <section
      aria-labelledby="platform-panel-heading"
      className="bg-card rounded-xl border p-6 shadow-sm"
    >
      <h2 id="platform-panel-heading" className="mb-3 text-base font-semibold">
        {t('media.detail.platforms.title')}
      </h2>

      {isError ? (
        <InlineErrorState message={t('media.detail.platforms.loadError')} onRetry={onRetry} />
      ) : isLoading || data === undefined ? (
        <PlatformPanelSkeleton />
      ) : data.length === 0 ? (
        <EmptyState title={t('media.detail.platforms.empty')} className="py-6" />
      ) : (
        <div className="overflow-x-auto">
          <Table aria-label={t('media.detail.platforms.title')}>
            <TableCaption className="sr-only">{t('media.detail.platforms.title')}</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('common:labels.platform')}</TableHead>
                <TableHead className="text-right">
                  {t('media.detail.platforms.columns.plays')}
                </TableHead>
                <TableHead className="text-right">{t(verbKeysFor(mediaType).watchTime)}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.map((entry, index) => (
                <TableRow key={`${entry.platform ?? ''}-${entry.player ?? ''}-${index}`}>
                  <TableCell>
                    <div className="font-medium">
                      {entry.platform ?? entry.player ?? t('media.detail.platforms.unknown')}
                    </div>
                    {entry.platform && entry.player && (
                      <div className="text-muted-foreground text-xs">{entry.player}</div>
                    )}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatNumber(entry.plays)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatDuration(entry.watchTimeMs, { style: 'compactShort' })}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
