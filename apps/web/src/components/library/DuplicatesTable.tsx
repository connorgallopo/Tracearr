import { useState, Fragment } from 'react';
import { ChevronRight, Copy } from 'lucide-react';
import type { DuplicatesResponse } from '@tracearr/shared';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from '@/components/ui/collapsible';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { MatchTypeBadge, EmptyState } from '@/components/library';

/**
 * Format bytes to human-readable string (GB or TB).
 */
function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 GB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb.toFixed(1)} GB`;
}

interface DuplicatesTableProps {
  data: DuplicatesResponse | undefined;
  isLoading?: boolean;
  page: number;
  onPageChange: (page: number) => void;
}

/**
 * Table component for displaying duplicate content groups.
 * Rows are expandable to show individual items within each duplicate group.
 */
export function DuplicatesTable({ data, isLoading, page, onPageChange }: DuplicatesTableProps) {
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
        <div className="text-muted-foreground">Loading duplicates...</div>
      </div>
    );
  }

  if (!data?.duplicates?.length) {
    return (
      <EmptyState
        icon={Copy}
        title="No duplicates found"
        description="No duplicate content detected across your libraries."
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
            <TableHead>Title</TableHead>
            <TableHead>Match Type</TableHead>
            <TableHead className="text-right">Copies</TableHead>
            <TableHead className="text-right">Recoverable Space</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.duplicates.map((group) => {
            const isExpanded = expandedGroups.has(group.matchKey);
            // Get representative title from first item
            const displayTitle = group.items[0]?.title ?? 'Unknown';
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
                          <MatchTypeBadge
                            matchType={group.matchType}
                            confidence={group.confidence}
                          />
                        </TableCell>
                        <TableCell className="text-right">{group.items.length}</TableCell>
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
                                <div
                                  key={item.id}
                                  className="flex items-center justify-between gap-4 text-sm"
                                >
                                  <div className="flex items-center gap-3">
                                    <Badge variant="outline">{item.serverName}</Badge>
                                    <span className="text-muted-foreground">
                                      {item.resolution ?? 'Unknown'}
                                    </span>
                                  </div>
                                  <span className="text-muted-foreground">
                                    {formatBytes(item.fileSize)}
                                  </span>
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

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-2">
          <span className="text-muted-foreground text-sm">
            Page {page} of {totalPages}
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
