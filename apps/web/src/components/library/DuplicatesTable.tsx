import { useState, useMemo, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Copy } from 'lucide-react';
import {
  formatEpisodeLabel,
  formatMediaTech,
  type DuplicateGroup,
  type DuplicatesResponse,
} from '@tracearr/shared';
import { cn, getMediaDisplay } from '@/lib/utils';
import { formatBytes } from '@/lib/formatters';
import { useDuplicateFiles } from '@/hooks/queries/useLibrary';
import { Badge } from '@/components/ui/badge';
import { CopyButton } from '@/components/ui/copy-button';
import { DataTablePager } from '@/components/ui/data-table';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MatchTypeBadge, MediaTypeBadge, InlineErrorState } from '@/components/library';
import { EmptyState } from '@/components/ui/empty-state';

/** Last path segment, for both posix and windows library roots */
function fileName(path: string): string {
  const segments = path.split(/[\\/]/);
  return segments[segments.length - 1] || path;
}

/**
 * One expanded group: every physical file of every copy, and whether the
 * server still has it. The existence check runs only while the group is open.
 */
function DuplicateGroupFiles({ group, expanded }: { group: DuplicateGroup; expanded: boolean }) {
  const { t } = useTranslation(['pages', 'common']);
  const itemIds = useMemo(() => group.items.map((item) => item.id), [group.items]);
  const { data } = useDuplicateFiles(itemIds, expanded);

  const missingFiles = useMemo(() => {
    const missing = new Set<string>();
    for (const file of data?.files ?? []) {
      if (!file.exists) missing.add(`${file.itemId}:${file.serverVersionKey}`);
    }
    return missing;
  }, [data]);

  return (
    <div className="space-y-2">
      {group.items.map((item) => {
        // An item with no version rows still has one file, described by its own columns
        const files =
          item.versions.length > 0
            ? item.versions
            : [
                {
                  serverVersionKey: '',
                  resolution: item.resolution,
                  videoCodec: null,
                  audioCodec: null,
                  fileSize: item.fileSize,
                  filePath: null,
                  isMirror: false,
                },
              ];

        const episodeLabel = formatEpisodeLabel(item.seasonNumber, item.episodeNumber, {
          spaced: true,
          mediaType: item.mediaType,
        });

        return (
          <div key={item.id} className="space-y-1">
            <div className="flex items-center justify-between gap-4 text-sm">
              <div className="flex items-center gap-3">
                <Badge variant="outline">{item.serverName}</Badge>
                {item.libraryName && <Badge variant="secondary">{item.libraryName}</Badge>}
                {episodeLabel && <span className="font-medium">{episodeLabel}</span>}
                <span className="text-muted-foreground">{formatMediaTech(item.resolution)}</span>
              </div>
              <span className="text-muted-foreground">{formatBytes(item.fileSize)}</span>
            </div>
            {files.map((file, index) => {
              // A track has no video, so its audio codec tells the copies apart
              const codec = file.videoCodec ?? file.audioCodec;
              const tech =
                [
                  file.resolution ? formatMediaTech(file.resolution) : null,
                  codec ? formatMediaTech(codec) : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || '—';
              const isMissing = missingFiles.has(`${item.id}:${file.serverVersionKey}`);

              return (
                <div
                  key={`${item.id}-v${index}`}
                  className="text-muted-foreground flex items-center justify-between gap-4 pl-6 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="shrink-0">{tech}</span>
                    {file.filePath && (
                      <span className="truncate font-mono" title={file.filePath}>
                        {fileName(file.filePath)}
                      </span>
                    )}
                    {file.isMirror && (
                      <Badge variant="outline" className="text-[10px]">
                        {t('library.storage.mirror')}
                      </Badge>
                    )}
                    {isMissing && (
                      <Badge
                        variant="destructive"
                        className="text-[10px]"
                        title={t('library.storage.missingOnServerHint')}
                      >
                        {t('library.storage.missingOnServer')}
                      </Badge>
                    )}
                  </span>
                  <span className="flex shrink-0 items-center gap-1">
                    {formatBytes(file.fileSize)}
                    {file.filePath && (
                      <CopyButton
                        value={file.filePath}
                        label={t('library.storage.copyPath')}
                        variant="ghost"
                        className="size-6"
                      />
                    )}
                  </span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

interface DuplicatesTableProps {
  data: DuplicatesResponse | undefined;
  isLoading?: boolean;
  isError?: boolean;
  onRetry: () => void;
  page: number;
  onPageChange: (page: number) => void;
}

/**
 * Table component for displaying duplicate content groups.
 * Rows are expandable to show individual items within each duplicate group.
 */
export function DuplicatesTable({
  data,
  isLoading,
  isError,
  onRetry,
  page,
  onPageChange,
}: DuplicatesTableProps) {
  const { t } = useTranslation(['pages', 'common']);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());

  const toggleGroup = (matchKey: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(matchKey)) next.delete(matchKey);
      else next.add(matchKey);
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="text-muted-foreground">{t('library.storage.loadingDuplicates')}</div>
      </div>
    );
  }

  if (isError) {
    return <InlineErrorState message={t('library.storage.duplicatesFailed')} onRetry={onRetry} />;
  }

  if (!data?.duplicates?.length) {
    return (
      <EmptyState
        icon={Copy}
        title={t('library.storage.noDuplicatesTitle')}
        description={t('library.storage.noDuplicatesDesc')}
      />
    );
  }

  const totalPages = Math.ceil(data.pagination.total / data.pagination.pageSize);

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead className="w-24">{t('common:labels.type')}</TableHead>
            <TableHead>{t('library.storage.colTitle')}</TableHead>
            <TableHead>{t('library.storage.colMatchType')}</TableHead>
            <TableHead className="text-right">{t('library.storage.colCopies')}</TableHead>
            <TableHead className="text-right">{t('library.storage.colRecoverable')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.duplicates.map((group) => {
            const isExpanded = expandedGroups.has(group.matchKey);
            // Every item in a group shares a title and a media type, so the first speaks for it
            const first = group.items[0];
            // No year here: the second line is for a parent title, and the year stays inline
            const { title: primary, subtitle: secondary } = getMediaDisplay({
              mediaType: first?.mediaType ?? null,
              mediaTitle: first?.title ?? t('common:labels.unknown'),
              grandparentTitle: first?.grandparentTitle,
              artistName: first?.grandparentTitle,
              albumName: first?.parentTitle,
              seasonNumber: first?.seasonNumber,
              episodeNumber: first?.episodeNumber,
            });

            return (
              <Fragment key={group.matchKey}>
                <Collapsible
                  asChild
                  open={isExpanded}
                  onOpenChange={() => toggleGroup(group.matchKey)}
                >
                  <>
                    <CollapsibleTrigger asChild>
                      <TableRow className="cursor-pointer">
                        <TableCell>
                          <ChevronRight
                            className={cn(
                              'h-4 w-4 transition-transform',
                              isExpanded && 'rotate-90'
                            )}
                          />
                        </TableCell>
                        <TableCell>
                          <MediaTypeBadge mediaType={first?.mediaType ?? ''} />
                        </TableCell>
                        <TableCell>
                          <div className="min-w-0">
                            <div className="truncate">
                              <span className="font-medium">{primary}</span>
                              {first?.year && (
                                <span className="text-muted-foreground ml-1">({first.year})</span>
                              )}
                            </div>
                            {secondary && (
                              <div className="text-muted-foreground truncate text-xs">
                                {secondary}
                              </div>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <MatchTypeBadge
                              matchType={group.matchType}
                              confidence={group.confidence}
                            />
                            {group.sameServer && (
                              <Badge variant="secondary">{t('library.storage.sameServer')}</Badge>
                            )}
                          </div>
                        </TableCell>
                        <TableCell className="text-right">
                          {/* Fallback covers responses cached before uniqueFileCount existed */}
                          {group.uniqueFileCount ??
                            group.items.reduce(
                              (count, item) => count + Math.max(item.versions.length, 1),
                              0
                            )}
                        </TableCell>
                        <TableCell className="text-right">
                          {formatBytes(group.potentialSavingsBytes)}
                        </TableCell>
                      </TableRow>
                    </CollapsibleTrigger>
                    <CollapsibleContent asChild>
                      <tr>
                        <td colSpan={6} className="p-0">
                          <div className="bg-muted/30 border-b px-4 py-3">
                            <DuplicateGroupFiles group={group} expanded={isExpanded} />
                          </div>
                        </td>
                      </tr>
                    </CollapsibleContent>
                  </>
                </Collapsible>
              </Fragment>
            );
          })}
        </TableBody>
      </Table>

      <DataTablePager
        page={page}
        pageCount={totalPages}
        canPrevious={page > 1}
        canNext={page < totalPages}
        onPrevious={() => onPageChange(page - 1)}
        onNext={() => onPageChange(page + 1)}
        onPage={onPageChange}
        labels={{
          navigation: t('common:table.pagination'),
          status: t('common:table.pageOf', { page, total: totalPages }),
          previous: t('common:actions.previous'),
          next: t('common:actions.next'),
          goToPage: t('common:table.goToPage'),
        }}
        className="px-2"
      />
    </div>
  );
}
