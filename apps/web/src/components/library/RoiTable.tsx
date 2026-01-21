import { Film, Tv, Music, ArrowUpDown, ArrowUp, ArrowDown, BarChart } from 'lucide-react';
import type { RoiResponse } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { ValueCategoryBadge, EmptyState } from '@/components/library';

type SortBy = 'watch_hours_per_gb' | 'value_score' | 'file_size' | 'title';
type SortOrder = 'asc' | 'desc';
type MediaTypeFilter = 'all' | 'movie' | 'show' | 'artist';

/**
 * Badge component for media type (Movie, TV, Music)
 */
function MediaTypeBadge({ mediaType }: { mediaType: string }) {
  switch (mediaType) {
    case 'movie':
      return (
        <Badge variant="secondary" className="gap-1">
          <Film className="h-3 w-3" />
          Movie
        </Badge>
      );
    case 'show':
      return (
        <Badge variant="secondary" className="gap-1 bg-blue-500/10 text-blue-500">
          <Tv className="h-3 w-3" />
          TV
        </Badge>
      );
    case 'artist':
      return (
        <Badge variant="secondary" className="gap-1 bg-purple-500/10 text-purple-500">
          <Music className="h-3 w-3" />
          Music
        </Badge>
      );
    default:
      return null;
  }
}

interface RoiTableProps {
  data: RoiResponse | undefined;
  isLoading?: boolean;
  page: number;
  onPageChange: (page: number) => void;
  sortBy: SortBy;
  sortOrder: SortOrder;
  onSortChange: (sortBy: SortBy, sortOrder: SortOrder) => void;
  mediaType: MediaTypeFilter;
  onMediaTypeChange: (mediaType: MediaTypeFilter) => void;
}

/**
 * Table component for displaying ROI (Return on Investment) analysis.
 * Server-side sortable by watch hours, file size, hours per GB, and title.
 */
export function RoiTable({
  data,
  isLoading,
  page,
  onPageChange,
  sortBy,
  sortOrder,
  onSortChange,
  mediaType,
  onMediaTypeChange,
}: RoiTableProps) {
  const handleSort = (field: SortBy) => {
    if (sortBy === field) {
      onSortChange(field, sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      // Default sort direction: title asc, others asc (low value first)
      onSortChange(field, field === 'title' ? 'asc' : 'asc');
    }
  };

  const SortIcon = ({ field }: { field: SortBy }) => {
    if (sortBy !== field) return <ArrowUpDown className="h-4 w-4 opacity-50" />;
    return sortOrder === 'asc' ? (
      <ArrowUp className="h-4 w-4" />
    ) : (
      <ArrowDown className="h-4 w-4" />
    );
  };

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-end">
          <Select value={mediaType} onValueChange={(v) => onMediaTypeChange(v as MediaTypeFilter)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="movie">Movies</SelectItem>
              <SelectItem value="show">TV Shows</SelectItem>
              <SelectItem value="artist">Music</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex h-48 items-center justify-center">
          <div className="text-muted-foreground">Loading ROI data...</div>
        </div>
      </div>
    );
  }

  if (!data?.items?.length) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-end">
          <Select value={mediaType} onValueChange={(v) => onMediaTypeChange(v as MediaTypeFilter)}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              <SelectItem value="movie">Movies</SelectItem>
              <SelectItem value="show">TV Shows</SelectItem>
              <SelectItem value="artist">Music</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <EmptyState
          icon={BarChart}
          title="No ROI data available"
          description="ROI analysis requires watch history data to calculate content value."
        />
      </div>
    );
  }

  const totalPages = Math.ceil(data.pagination.total / data.pagination.pageSize);

  return (
    <div className="space-y-4">
      {/* Filter controls */}
      <div className="flex items-center justify-end">
        <Select value={mediaType} onValueChange={(v) => onMediaTypeChange(v as MediaTypeFilter)}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            <SelectItem value="movie">Movies</SelectItem>
            <SelectItem value="show">TV Shows</SelectItem>
            <SelectItem value="artist">Music</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>
              <button
                className="hover:text-foreground flex items-center gap-1"
                onClick={() => handleSort('title')}
              >
                Title
                <SortIcon field="title" />
              </button>
            </TableHead>
            <TableHead>
              <button
                className="hover:text-foreground flex items-center gap-1"
                onClick={() => handleSort('file_size')}
              >
                Size
                <SortIcon field="file_size" />
              </button>
            </TableHead>
            <TableHead>Watch Hours</TableHead>
            <TableHead>
              <button
                className="hover:text-foreground flex items-center gap-1"
                onClick={() => handleSort('watch_hours_per_gb')}
              >
                Hours/GB
                <SortIcon field="watch_hours_per_gb" />
              </button>
            </TableHead>
            <TableHead>Value</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map((item) => (
            <TableRow key={item.id}>
              <TableCell>
                <div className="flex items-center gap-2">
                  <MediaTypeBadge mediaType={item.mediaType} />
                  <div>
                    <span className="font-medium">{item.title}</span>
                    {item.year && <span className="text-muted-foreground ml-1">({item.year})</span>}
                  </div>
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
