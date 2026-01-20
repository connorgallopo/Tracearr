import { useState, useMemo } from 'react';
import { ChevronUp, ChevronDown, BarChart } from 'lucide-react';
import type { RoiResponse } from '@tracearr/shared';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ValueCategoryBadge, EmptyState } from '@/components/library';

type SortField = 'watchHoursPerGb' | 'fileSizeGb' | 'totalWatchHours';
type SortDir = 'asc' | 'desc';

interface RoiTableProps {
  data: RoiResponse | undefined;
  isLoading?: boolean;
  page: number;
  onPageChange: (page: number) => void;
}

/**
 * Table component for displaying ROI (Return on Investment) analysis.
 * Sortable by watch hours, file size, and hours per GB.
 */
export function RoiTable({ data, isLoading, page, onPageChange }: RoiTableProps) {
  const [sortField, setSortField] = useState<SortField>('watchHoursPerGb');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  // Client-side sorting (data already paginated from API)
  const sortedItems = useMemo(() => {
    if (!data?.items) return [];
    return [...data.items].sort((a, b) => {
      const aVal = a[sortField] ?? 0;
      const bVal = b[sortField] ?? 0;
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    });
  }, [data?.items, sortField, sortDir]);

  if (isLoading) {
    return (
      <div className="flex h-48 items-center justify-center">
        <div className="text-muted-foreground">Loading ROI data...</div>
      </div>
    );
  }

  if (!data?.items?.length) {
    return (
      <EmptyState
        icon={BarChart}
        title="No ROI data available"
        description="ROI analysis requires watch history data to calculate content value."
      />
    );
  }

  const totalPages = Math.ceil(data.pagination.total / data.pagination.pageSize);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const SortableHeader = ({ field, label }: { field: SortField; label: string }) => {
    const isActive = sortField === field;
    return (
      <TableHead className="cursor-pointer select-none" onClick={() => handleSort(field)}>
        <div className="flex items-center gap-1">
          {label}
          {isActive &&
            (sortDir === 'asc' ? (
              <ChevronUp className="h-4 w-4" />
            ) : (
              <ChevronDown className="h-4 w-4" />
            ))}
        </div>
      </TableHead>
    );
  };

  return (
    <div className="space-y-4">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <SortableHeader field="fileSizeGb" label="Size" />
            <SortableHeader field="totalWatchHours" label="Watch Hours" />
            <SortableHeader field="watchHoursPerGb" label="Hours/GB" />
            <TableHead>Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sortedItems.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <div>
                  <span className="font-medium">{item.title}</span>
                  {item.year && <span className="text-muted-foreground ml-1">({item.year})</span>}
                </div>
              </TableCell>
              <TableCell>{item.fileSizeGb.toFixed(1)} GB</TableCell>
              <TableCell>{item.totalWatchHours.toFixed(1)}</TableCell>
              <TableCell>{item.watchHoursPerGb.toFixed(2)}</TableCell>
              <TableCell>
                <ValueCategoryBadge
                  category={item.valueCategory}
                  suggestDeletion={item.suggestDeletion}
                />
              </TableCell>
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
