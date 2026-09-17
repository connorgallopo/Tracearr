import { useTranslation } from 'react-i18next';
import { format } from 'date-fns';
import { formatMediaTech, type MediaAvailabilityEntry } from '@tracearr/shared';
import type { HeroServerLookupEntry } from './DetailHero';
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
import { formatBytes } from '@/lib/formatters';

interface CopiesPanelProps {
  availability: MediaAvailabilityEntry[] | undefined;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  serverById: Map<string, HeroServerLookupEntry>;
}

const MAX_RESOLUTIONS_SHOWN = 3;

/** "4K · 1080p" from the rollup, capped at three entries then "+N". */
function formatResolutionSet(resolutions: string[]): string {
  const shown = resolutions.slice(0, MAX_RESOLUTIONS_SHOWN).map(formatMediaTech).join(' · ');
  const extra = resolutions.length - MAX_RESOLUTIONS_SHOWN;
  return extra > 0 ? `${shown} +${extra}` : shown;
}

function CopiesPanelSkeleton() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-4 flex-1" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-16" />
          <Skeleton className="h-4 w-20" />
        </div>
      ))}
    </div>
  );
}

export function CopiesPanel({
  availability,
  isLoading,
  isError,
  onRetry,
  serverById,
}: CopiesPanelProps) {
  const { t } = useTranslation('pages');

  const activeCopies = (availability ?? []).filter((entry) => entry.removedAt == null);
  const hasEpisodeCounts = activeCopies.some((entry) => entry.episodeCount != null);

  return (
    <section
      aria-labelledby="copies-panel-heading"
      className="bg-card rounded-[calc(var(--radius)+2px)] border p-[16px_18px]"
    >
      <h2 id="copies-panel-heading" className="mb-3 text-[15px] font-semibold">
        {t('media.detail.copies.title')}
      </h2>

      {isError ? (
        <InlineErrorState message={t('media.detail.copies.loadError')} onRetry={onRetry} />
      ) : isLoading || availability === undefined ? (
        <CopiesPanelSkeleton />
      ) : activeCopies.length === 0 ? (
        <EmptyState title={t('media.detail.hero.removedEverywhere.caption')} className="py-6" />
      ) : (
        <div className="overflow-x-auto">
          <Table aria-label={t('media.detail.copies.title')}>
            <TableCaption className="sr-only">{t('media.detail.copies.title')}</TableCaption>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('media.detail.copies.columns.server')}</TableHead>
                <TableHead>{t('media.detail.copies.columns.library')}</TableHead>
                <TableHead>{t('media.detail.copies.columns.quality')}</TableHead>
                {hasEpisodeCounts && (
                  <TableHead className="text-right">
                    {t('media.detail.copies.columns.episodes')}
                  </TableHead>
                )}
                <TableHead className="text-right">
                  {t('media.detail.copies.columns.size')}
                </TableHead>
                <TableHead className="text-right">
                  {t('media.detail.copies.columns.added')}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {activeCopies.flatMap((entry) => {
                const server = serverById.get(entry.serverId);
                const quality =
                  entry.episodeResolutions && entry.episodeResolutions.length > 0
                    ? formatResolutionSet(entry.episodeResolutions)
                    : entry.videoResolution
                      ? formatMediaTech(entry.videoResolution)
                      : null;
                const sizeBytes = entry.fileSize ?? entry.episodeFileSize;
                const mainRow = (
                  <TableRow key={`${entry.serverId}-${entry.libraryId}-${entry.ratingKey}`}>
                    <TableCell>
                      <div className="flex items-center gap-2 font-medium">
                        <span
                          aria-hidden="true"
                          className="bg-muted-foreground h-1.5 w-1.5 shrink-0 rounded-full"
                          style={server?.color ? { backgroundColor: server.color } : undefined}
                        />
                        <span className="truncate">{server?.name ?? entry.serverId}</span>
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {entry.libraryName ?? t('media.detail.copies.unknownLibrary')}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{quality ?? '—'}</TableCell>
                    {hasEpisodeCounts && (
                      <TableCell className="text-muted-foreground text-right tabular-nums">
                        {entry.episodeCount ?? '—'}
                      </TableCell>
                    )}
                    <TableCell className="text-muted-foreground text-right tabular-nums">
                      {sizeBytes != null ? formatBytes(sizeBytes, 1, { minUnit: 'GB' }) : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-right tabular-nums">
                      {format(new Date(entry.addedAt), 'MMM d, yyyy')}
                    </TableCell>
                  </TableRow>
                );
                // Version sub-rows sit directly under their copy so a file is
                // always attributable to the server row above it
                const versionRows =
                  entry.versions.length > 1
                    ? entry.versions.map((version, index) => (
                        <TableRow
                          key={`${entry.serverId}-${entry.ratingKey}-v${index}`}
                          className="bg-muted/30"
                        >
                          <TableCell className="text-muted-foreground pl-8 text-xs">
                            {t('media.detail.copies.versionLabel', { index: index + 1 })}
                          </TableCell>
                          <TableCell />
                          <TableCell className="text-muted-foreground text-xs">
                            {[
                              version.resolution ? formatMediaTech(version.resolution) : null,
                              version.videoCodec ? formatMediaTech(version.videoCodec) : null,
                              version.dynamicRange && version.dynamicRange !== 'sdr'
                                ? formatMediaTech(version.dynamicRange)
                                : null,
                            ]
                              .filter(Boolean)
                              .join(' · ') || '—'}
                          </TableCell>
                          {hasEpisodeCounts && <TableCell />}
                          <TableCell className="text-muted-foreground text-right text-xs tabular-nums">
                            {version.fileSize != null
                              ? formatBytes(version.fileSize, 1, { minUnit: 'GB' })
                              : '—'}
                          </TableCell>
                          <TableCell />
                        </TableRow>
                      ))
                    : [];
                return [mainRow, ...versionRows];
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
