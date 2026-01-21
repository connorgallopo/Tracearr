import { Film, ArrowUpDown, ArrowUp, ArrowDown, BarChart3 } from 'lucide-react';
import type { TopMoviesResponse } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/library';

type MovieSortBy = 'plays' | 'watch_hours' | 'viewers' | 'completion_rate';
type SortOrder = 'asc' | 'desc';

interface TopMoviesTableProps {
  data: TopMoviesResponse | undefined;
  isLoading?: boolean;
  page: number;
  onPageChange: (page: number) => void;
  sortBy: MovieSortBy;
  sortOrder: SortOrder;
  onSortChange: (sortBy: MovieSortBy, sortOrder: SortOrder) => void;
}

/**
 * Get completion rate badge based on percentage.
 */
function getCompletionBadge(rate: number) {
  if (rate >= 80) return <Badge variant="success">{rate.toFixed(0)}%</Badge>;
  if (rate >= 50) return <Badge variant="secondary">{rate.toFixed(0)}%</Badge>;
  if (rate >= 20) return <Badge variant="warning">{rate.toFixed(0)}%</Badge>;
  return <Badge variant="outline">{rate.toFixed(0)}%</Badge>;
}

/**
 * Table component for displaying top movies by engagement metrics.
 * Server-side sortable by plays, watch hours, viewers, and completion rate.
 */
export function TopMoviesTable({
  data,
  isLoading,
  page,
  onPageChange,
  sortBy,
  sortOrder,
  onSortChange,
}: TopMoviesTableProps) {
  const handleSort = (field: MovieSortBy) => {
    if (sortBy === field) {
      onSortChange(field, sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      // Default sort direction: desc for metrics
      onSortChange(field, 'desc');
    }
  };

  const SortIcon = ({ field }: { field: MovieSortBy }) => {
    if (sortBy !== field) return <ArrowUpDown className="h-4 w-4 opacity-50" />;
    return sortOrder === 'asc' ? (
      <ArrowUp className="h-4 w-4" />
    ) : (
      <ArrowDown className="h-4 w-4" />
    );
  };

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="text-muted-foreground">Loading movies...</div>
      </div>
    );
  }

  if (!data?.items?.length) {
    return (
      <EmptyState
        icon={BarChart3}
        title="No movie watch data"
        description="Movie watch statistics will appear here once content has been played."
      />
    );
  }

  const totalPages = Math.ceil(data.pagination.total / data.pagination.pageSize);

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">Title</TableHead>
            <TableHead>
              <button
                className="hover:text-foreground flex items-center gap-1"
                onClick={() => handleSort('plays')}
              >
                Plays
                <SortIcon field="plays" />
              </button>
            </TableHead>
            <TableHead>
              <button
                className="hover:text-foreground flex items-center gap-1"
                onClick={() => handleSort('watch_hours')}
              >
                Watch Hours
                <SortIcon field="watch_hours" />
              </button>
            </TableHead>
            <TableHead>
              <button
                className="hover:text-foreground flex items-center gap-1"
                onClick={() => handleSort('viewers')}
              >
                Viewers
                <SortIcon field="viewers" />
              </button>
            </TableHead>
            <TableHead>
              <button
                className="hover:text-foreground flex items-center gap-1"
                onClick={() => handleSort('completion_rate')}
              >
                Completion
                <SortIcon field="completion_rate" />
              </button>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((item) => (
            <TableRow key={item.ratingKey}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <Badge variant="secondary" className="gap-1">
                    <Film className="h-3 w-3" />
                    Movie
                  </Badge>
                  <div>
                    <span className="font-medium">{item.title}</span>
                    {item.year && <span className="text-muted-foreground ml-1">({item.year})</span>}
                  </div>
                </div>
              </TableCell>
              <TableCell className="font-medium">{item.totalPlays}</TableCell>
              <TableCell>{item.totalWatchHours.toFixed(1)}</TableCell>
              <TableCell>{item.uniqueViewers}</TableCell>
              <TableCell>{getCompletionBadge(item.completionRate)}</TableCell>
            </TableRow>
          ))}
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
