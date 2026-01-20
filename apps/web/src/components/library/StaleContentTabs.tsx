import { useState, useEffect } from 'react';
import { Archive } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import type { StaleResponse } from '@tracearr/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { useLibraryStale } from '@/hooks/queries/useLibrary';
import { EmptyState } from '@/components/library';

/**
 * Format bytes to human-readable string (GB or TB).
 */
function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 GB';
  const gb = bytes / 1024 ** 3;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  return `${gb.toFixed(1)} GB`;
}

interface StaleContentTabsProps {
  serverId?: string | null;
  libraryId?: string | null;
}

/**
 * Tabbed component for displaying never-watched and stale content.
 * Includes a threshold selector for the "stale" category (3m/6m/1y/2y).
 */
export function StaleContentTabs({ serverId, libraryId }: StaleContentTabsProps) {
  const [activeTab, setActiveTab] = useState<'never-watched' | 'stale'>('never-watched');
  const [staleDays, setStaleDays] = useState('90');
  const [neverWatchedPage, setNeverWatchedPage] = useState(1);
  const [stalePage, setStalePage] = useState(1);

  // Reset stale page when threshold changes
  useEffect(() => {
    setStalePage(1);
  }, [staleDays]);

  // Fetch both to avoid flicker on tab switch
  // staleDays=0 triggers never_watched category on backend
  const neverWatched = useLibraryStale(serverId, libraryId, 0, neverWatchedPage, 20);
  const stale = useLibraryStale(serverId, libraryId, Number(staleDays), stalePage, 20);

  const handleTabChange = (value: string) => {
    setActiveTab(value as 'never-watched' | 'stale');
  };

  const renderTable = (
    data: StaleResponse | undefined,
    isLoading: boolean,
    page: number,
    onPageChange: (page: number) => void
  ) => {
    if (isLoading) {
      return (
        <div className="flex h-48 items-center justify-center">
          <div className="text-muted-foreground">Loading...</div>
        </div>
      );
    }

    if (!data?.items?.length) {
      return (
        <EmptyState
          icon={Archive}
          title="No stale content"
          description="All content in your library has been watched recently."
        />
      );
    }

    const totalPages = Math.ceil(data.pagination.total / data.pagination.pageSize);

    return (
      <div className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Title</TableHead>
              <TableHead>Server</TableHead>
              <TableHead className="text-right">Size</TableHead>
              <TableHead>Added</TableHead>
              <TableHead>Last Watched</TableHead>
              <TableHead>Quality</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.items.map((item) => (
              <TableRow key={item.id}>
                <TableCell>
                  <div>
                    <span className="font-medium">{item.title}</span>
                    {item.year && <span className="text-muted-foreground ml-1">({item.year})</span>}
                  </div>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{item.serverName}</Badge>
                </TableCell>
                <TableCell className="text-right">{formatBytes(item.fileSize)}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDistanceToNow(new Date(item.addedAt), { addSuffix: true })}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {item.lastWatched
                    ? formatDistanceToNow(new Date(item.lastWatched), { addSuffix: true })
                    : 'Never'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {item.resolution ?? 'Unknown'}
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
  };

  return (
    <Tabs value={activeTab} onValueChange={handleTabChange}>
      <div className="mb-4 flex items-center justify-between">
        <TabsList>
          <TabsTrigger value="never-watched">
            Never Watched ({neverWatched.data?.summary.neverWatched.count ?? 0})
          </TabsTrigger>
          <TabsTrigger value="stale">
            Not Watched Recently ({stale.data?.summary.stale.count ?? 0})
          </TabsTrigger>
        </TabsList>

        {/* Threshold selector (only for stale tab) */}
        {activeTab === 'stale' && (
          <Select value={staleDays} onValueChange={setStaleDays}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="90">3 months</SelectItem>
              <SelectItem value="180">6 months</SelectItem>
              <SelectItem value="365">1 year</SelectItem>
              <SelectItem value="730">2 years</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      <TabsContent value="never-watched">
        {renderTable(
          neverWatched.data,
          neverWatched.isLoading,
          neverWatchedPage,
          setNeverWatchedPage
        )}
      </TabsContent>
      <TabsContent value="stale">
        {renderTable(stale.data, stale.isLoading, stalePage, setStalePage)}
      </TabsContent>
    </Tabs>
  );
}
