import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Film, Tv } from 'lucide-react';
import type { Server } from '@tracearr/shared';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TopMoviesTable } from './TopMoviesTable';
import { TopShowsTable, type ShowSortBy } from './TopShowsTable';
import { useTopMovies, useTopShows } from '@/hooks/queries';
import { toApiLibraryParams } from '@/hooks/useTimeRange';
import type { TimeRangeValue } from '@/components/ui/time-range-picker';

type MovieSortBy = 'plays' | 'watch_hours' | 'viewers' | 'completion_rate';
type SortOrder = 'asc' | 'desc';

interface MostWatchedSectionProps {
  serverIds: string[];
  selectedServers: Server[];
  isMultiServer: boolean;
  timeRange: TimeRangeValue;
}

/**
 * Container component for Most Watched section with Movies/Shows tabs.
 * Manages separate state for each tab (sorting, pagination).
 */
export function MostWatchedSection({
  serverIds,
  selectedServers,
  isMultiServer,
  timeRange,
}: MostWatchedSectionProps) {
  const { t } = useTranslation(['pages', 'common']);
  const { period, startDate, endDate } = toApiLibraryParams(timeRange);
  const rangeKey = `${period}:${startDate}:${endDate}`;
  const [prevRangeKey, setPrevRangeKey] = useState(rangeKey);
  const [activeTab, setActiveTab] = useState<'movies' | 'shows'>('movies');

  // Movies state
  const [moviesPage, setMoviesPage] = useState(1);
  const [moviesSortBy, setMoviesSortBy] = useState<MovieSortBy>('plays');
  const [moviesSortOrder, setMoviesSortOrder] = useState<SortOrder>('desc');

  // Shows state
  const [showsPage, setShowsPage] = useState(1);
  const [showsSortBy, setShowsSortBy] = useState<ShowSortBy>('plays');
  const [showsSortOrder, setShowsSortOrder] = useState<SortOrder>('desc');

  if (prevRangeKey !== rangeKey) {
    setPrevRangeKey(rangeKey);
    setMoviesPage(1);
    setShowsPage(1);
  }

  // Data fetching
  const movies = useTopMovies(
    serverIds,
    period,
    moviesSortBy,
    moviesSortOrder,
    moviesPage,
    10,
    startDate,
    endDate
  );

  const shows = useTopShows(
    serverIds,
    period,
    showsSortBy,
    showsSortOrder,
    showsPage,
    10,
    startDate,
    endDate
  );

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
      <CardHeader>
        <CardTitle className="text-base font-medium">{t('library.watch.mostWatched')}</CardTitle>
      </CardHeader>
      <CardContent>
        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'movies' | 'shows')}>
          <TabsList className="mb-4">
            <TabsTrigger value="movies" className="gap-2">
              <Film className="h-4 w-4" />
              {t('common:media.movie_plural')}
              {movies.data?.summary.totalMovies !== undefined && (
                <span className="text-muted-foreground ml-1">
                  ({movies.data.summary.totalMovies})
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="shows" className="gap-2">
              <Tv className="h-4 w-4" />
              {t('common:media.tvShows')}
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
              selectedServers={selectedServers}
              isMultiServer={isMultiServer}
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
              selectedServers={selectedServers}
              isMultiServer={isMultiServer}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
