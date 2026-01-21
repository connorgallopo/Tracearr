import { useState } from 'react';
import { Film, Tv } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { TopMoviesTable } from './TopMoviesTable';
import { TopShowsTable } from './TopShowsTable';
import { useTopMovies, useTopShows } from '@/hooks/queries';

type Period = '7d' | '30d' | '90d' | '1y' | 'all';
type MovieSortBy = 'plays' | 'watch_hours' | 'viewers' | 'completion_rate';
type ShowSortBy = 'plays' | 'watch_hours' | 'viewers' | 'completion_rate' | 'binge_score';
type SortOrder = 'asc' | 'desc';

interface MostWatchedSectionProps {
  serverId?: string | null;
}

const PERIOD_OPTIONS = [
  { value: '7d', label: 'Last 7 days' },
  { value: '30d', label: 'Last 30 days' },
  { value: '90d', label: 'Last 90 days' },
  { value: '1y', label: 'Last year' },
  { value: 'all', label: 'All time' },
] as const;

/**
 * Container component for Most Watched section with Movies/Shows tabs.
 * Manages separate state for each tab (sorting, pagination).
 */
export function MostWatchedSection({ serverId }: MostWatchedSectionProps) {
  // Shared state
  const [period, setPeriod] = useState<Period>('30d');
  const [activeTab, setActiveTab] = useState<'movies' | 'shows'>('movies');

  // Movies state
  const [moviesPage, setMoviesPage] = useState(1);
  const [moviesSortBy, setMoviesSortBy] = useState<MovieSortBy>('plays');
  const [moviesSortOrder, setMoviesSortOrder] = useState<SortOrder>('desc');

  // Shows state
  const [showsPage, setShowsPage] = useState(1);
  const [showsSortBy, setShowsSortBy] = useState<ShowSortBy>('plays');
  const [showsSortOrder, setShowsSortOrder] = useState<SortOrder>('desc');

  // Data fetching
  const movies = useTopMovies(serverId, period, moviesSortBy, moviesSortOrder, moviesPage, 10);

  const shows = useTopShows(serverId, period, showsSortBy, showsSortOrder, showsPage, 10);

  // Reset pages when period changes
  const handlePeriodChange = (newPeriod: Period) => {
    setPeriod(newPeriod);
    setMoviesPage(1);
    setShowsPage(1);
  };

  // Handle movies sort
  const handleMoviesSortChange = (sortBy: MovieSortBy, sortOrder: SortOrder) => {
    setMoviesSortBy(sortBy);
    setMoviesSortOrder(sortOrder);
    setMoviesPage(1); // Reset to first page on sort change
  };

  // Handle shows sort
  const handleShowsSortChange = (sortBy: ShowSortBy, sortOrder: SortOrder) => {
    setShowsSortBy(sortBy);
    setShowsSortOrder(sortOrder);
    setShowsPage(1); // Reset to first page on sort change
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base font-medium">Most Watched</CardTitle>
          <Select value={period} onValueChange={(v) => handlePeriodChange(v as Period)}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PERIOD_OPTIONS.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'movies' | 'shows')}>
          <TabsList className="mb-4">
            <TabsTrigger value="movies" className="gap-2">
              <Film className="h-4 w-4" />
              Movies
              {movies.data?.summary.totalMovies !== undefined && (
                <span className="text-muted-foreground ml-1">
                  ({movies.data.summary.totalMovies})
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="shows" className="gap-2">
              <Tv className="h-4 w-4" />
              TV Shows
              {shows.data?.summary.totalShows !== undefined && (
                <span className="text-muted-foreground ml-1">
                  ({shows.data.summary.totalShows})
                </span>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="movies">
            <TopMoviesTable
              data={movies.data}
              isLoading={movies.isLoading}
              page={moviesPage}
              onPageChange={setMoviesPage}
              sortBy={moviesSortBy}
              sortOrder={moviesSortOrder}
              onSortChange={handleMoviesSortChange}
            />
          </TabsContent>

          <TabsContent value="shows">
            <TopShowsTable
              data={shows.data}
              isLoading={shows.isLoading}
              page={showsPage}
              onPageChange={setShowsPage}
              sortBy={showsSortBy}
              sortOrder={showsSortOrder}
              onSortChange={handleShowsSortChange}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
