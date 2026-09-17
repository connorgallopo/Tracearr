import { useState, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Copy } from 'lucide-react';
import { formatMediaTech, type DuplicatesResponse } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { formatBytes } from '@/lib/formatters';
import { Badge } from '@/components/ui/badge';
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
import { MatchTypeBadge, InlineErrorState } from '@/components/library';
import { EmptyState } from '@/components/ui/empty-state';

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
            <TableHead>{t('library.storage.colTitle')}</TableHead>
            <TableHead>{t('library.storage.colMatchType')}</TableHead>
            <TableHead className="text-right">{t('library.storage.colCopies')}</TableHead>
            <TableHead className="text-right">{t('library.storage.colRecoverable')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.duplicates.map((group) => {
            const isExpanded = expandedGroups.has(group.matchKey);
            // Get representative title from first item
            const displayTitle = group.items[0]?.title ?? t('common:labels.unknown');
            const displayYear = group.items[0]?.year;

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
                          <div>
                            <span className="font-medium">{displayTitle}</span>
                            {displayYear && (
                              <span className="text-muted-foreground ml-1">({displayYear})</span>
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
                        <td colSpan={5} className="p-0">
                          <div className="bg-muted/30 border-b px-4 py-3">
                            <div className="space-y-2">
                              {group.items.map((item) => (
                                <div key={item.id} className="space-y-1">
                                  <div className="flex items-center justify-between gap-4 text-sm">
                                    <div className="flex items-center gap-3">
                                      <Badge variant="outline">{item.serverName}</Badge>
                                      {item.libraryName && (
                                        <Badge variant="secondary">{item.libraryName}</Badge>
                                      )}
                                      <span className="text-muted-foreground">
                                        {formatMediaTech(item.resolution)}
                                      </span>
                                    </div>
                                    <span className="text-muted-foreground">
                                      {formatBytes(item.fileSize)}
                                    </span>
                                  </div>
                                  {item.versions.length > 1 &&
                                    item.versions.map((version, index) => (
                                      <div
                                        key={`${item.id}-v${index}`}
                                        className="text-muted-foreground flex items-center justify-between gap-4 pl-6 text-xs"
                                      >
                                        <span className="flex items-center gap-2">
                                          {[
                                            version.resolution
                                              ? formatMediaTech(version.resolution)
                                              : null,
                                            version.videoCodec
                                              ? formatMediaTech(version.videoCodec)
                                              : null,
                                          ]
                                            .filter(Boolean)
                                            .join(' · ') || '—'}
                                          {version.isMirror && (
                                            <Badge variant="outline" className="text-[10px]">
                                              {t('library.storage.mirror')}
                                            </Badge>
                                          )}
                                        </span>
                                        <span>{formatBytes(version.fileSize)}</span>
                                      </div>
                                    ))}
                                </div>
                              ))}
                            </div>
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
