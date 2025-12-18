import { Film, Tv } from 'lucide-react';
import { TimeRangePicker } from '@/components/ui/time-range-picker';
import { MediaCard, MediaCardSmall } from '@/components/media';
import { Skeleton } from '@/components/ui/skeleton';
import { useTopContent } from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';
import { useTimeRange } from '@/hooks/useTimeRange';

export function StatsLibrary() {
  const { value: timeRange, setValue: setTimeRange, apiParams } = useTimeRange();
  const { selectedServerId } = useServer();
  const topContent = useTopContent(apiParams, selectedServerId);

  // Use separate movies and shows arrays from API
  const movies = topContent.data?.movies ?? [];
  const shows = topContent.data?.shows ?? [];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Library</h1>
          <p className="text-muted-foreground text-sm">Top movies and shows on your server</p>
        </div>
        <TimeRangePicker value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Top Movies Section */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Film className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">Top Movies</h2>
        </div>

        {topContent.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-44 w-full rounded-xl" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[2/3] rounded-lg" />
              ))}
            </div>
          </div>
        ) : (
          (() => {
            const topMovie = movies[0];
            if (!topMovie) {
              return (
                <div className="rounded-xl border border-dashed p-8 text-center">
                  <Film className="text-muted-foreground/50 mx-auto h-12 w-12" />
                  <p className="text-muted-foreground mt-2">No movie plays in this period</p>
                </div>
              );
            }
            return (
              <div className="space-y-4">
                {/* Featured #1 movie */}
                <MediaCard
                  title={topMovie.title}
                  type={topMovie.type}
                  year={topMovie.year}
                  playCount={topMovie.playCount}
                  watchTimeHours={topMovie.watchTimeHours}
                  thumbPath={topMovie.thumbPath}
                  serverId={topMovie.serverId}
                  rank={1}
                />

                {/* Grid of remaining movies */}
                {movies.length > 1 && (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,180px))] gap-4">
                    {movies.slice(1, 10).map((movie, index: number) => (
                      <MediaCardSmall
                        key={`${movie.title}-${movie.year}`}
                        title={movie.title}
                        type={movie.type}
                        year={movie.year}
                        playCount={movie.playCount}
                        thumbPath={movie.thumbPath}
                        serverId={movie.serverId}
                        rank={index + 2}
                        style={{ animationDelay: `${index * 50}ms` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })()
        )}
      </section>

      {/* Top Shows Section */}
      <section>
        <div className="mb-4 flex items-center gap-2">
          <Tv className="text-primary h-5 w-5" />
          <h2 className="text-lg font-semibold">Top TV Shows</h2>
        </div>

        {topContent.isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-44 w-full rounded-xl" />
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="aspect-[2/3] rounded-lg" />
              ))}
            </div>
          </div>
        ) : (
          (() => {
            const topShow = shows[0];
            if (!topShow) {
              return (
                <div className="rounded-xl border border-dashed p-8 text-center">
                  <Tv className="text-muted-foreground/50 mx-auto h-12 w-12" />
                  <p className="text-muted-foreground mt-2">No TV show plays in this period</p>
                </div>
              );
            }
            return (
              <div className="space-y-4">
                {/* Featured #1 show - title is the series name */}
                <MediaCard
                  title={topShow.title}
                  type={topShow.type}
                  year={topShow.year}
                  playCount={topShow.playCount}
                  watchTimeHours={topShow.watchTimeHours}
                  thumbPath={topShow.thumbPath}
                  serverId={topShow.serverId}
                  rank={1}
                  episodeCount={topShow.episodeCount}
                />

                {/* Grid of remaining shows */}
                {shows.length > 1 && (
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,180px))] gap-4">
                    {shows.slice(1, 10).map((show, idx: number) => (
                      <MediaCardSmall
                        key={`${show.title}-${show.year}`}
                        title={show.title}
                        type={show.type}
                        year={show.year}
                        playCount={show.playCount}
                        thumbPath={show.thumbPath}
                        serverId={show.serverId}
                        rank={idx + 2}
                        episodeCount={show.episodeCount}
                        style={{ animationDelay: `${idx * 50}ms` }}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })()
        )}
      </section>
    </div>
  );
}
