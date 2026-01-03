import { Film, Tv, Music, Radio } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

interface MediaCardProps {
  title: string;
  type: string;
  showTitle?: string | null;
  year?: number | null;
  playCount: number;
  watchTimeHours: number;
  thumbPath?: string | null;
  serverId?: string | null;
  rank?: number;
  className?: string;
  /** For TV shows (aggregated series), number of unique episodes watched */
  episodeCount?: number;
  /** Engagement stats for shows */
  bingeScore?: number;
  completionRate?: number;
}

function MediaIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case 'movie':
      return <Film className={className} />;
    case 'episode':
      return <Tv className={className} />;
    case 'track':
      return <Music className={className} />;
    case 'live':
      return <Radio className={className} />;
    default:
      return <Film className={className} />;
  }
}

function getImageUrl(
  serverId: string | null | undefined,
  thumbPath: string | null | undefined,
  width = 300,
  height = 450
) {
  if (!serverId || !thumbPath) return null;
  return `/api/v1/images/proxy?server=${encodeURIComponent(serverId)}&url=${encodeURIComponent(thumbPath)}&width=${width}&height=${height}&fallback=poster`;
}

export function MediaCard({
  title,
  type,
  showTitle,
  year,
  playCount,
  watchTimeHours,
  thumbPath,
  serverId,
  rank,
  className,
  episodeCount,
  bingeScore,
  completionRate,
}: MediaCardProps) {
  const imageUrl = getImageUrl(serverId, thumbPath, 300, 450);
  const bgImageUrl = getImageUrl(serverId, thumbPath, 800, 400);
  // For individual episodes: showTitle is series name, title is episode name
  // For aggregated shows: title is series name (no showTitle), episodeCount indicates it's aggregated
  const displayTitle = type === 'episode' && showTitle ? showTitle : title;
  const subtitle = episodeCount
    ? `${episodeCount} episodes • ${year || ''}`
    : type === 'episode'
      ? title
      : year
        ? `(${year})`
        : '';

  return (
    <div
      className={cn(
        'group animate-fade-in-up bg-card hover:shadow-primary/10 relative overflow-hidden rounded-xl border transition-all duration-300 hover:shadow-lg',
        className
      )}
    >
      {/* Background with blur */}
      <div
        className="absolute inset-0 bg-cover bg-center opacity-30 blur-xl transition-opacity group-hover:opacity-40"
        style={{
          backgroundImage: bgImageUrl ? `url(${bgImageUrl})` : undefined,
          backgroundColor: bgImageUrl ? undefined : 'hsl(var(--muted))',
        }}
      />
      <div className="from-card via-card/80 absolute inset-0 bg-gradient-to-t to-transparent" />

      {/* Content */}
      <div className="relative flex gap-4 p-4">
        {/* Poster */}
        <div className="bg-muted relative h-36 w-24 shrink-0 overflow-hidden rounded-lg shadow-lg transition-transform group-hover:scale-105">
          {imageUrl ? (
            <img
              src={imageUrl}
              alt={displayTitle}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <MediaIcon type={type} className="text-muted-foreground h-8 w-8" />
            </div>
          )}
          {rank && (
            <div className="bg-primary text-primary-foreground absolute -top-1 -left-1 flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold shadow-md">
              #{rank}
            </div>
          )}
        </div>

        {/* Info */}
        <div className="flex flex-1 flex-col justify-center">
          <div className="flex items-center gap-2">
            <MediaIcon type={type} className="text-muted-foreground h-4 w-4" />
            <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              {type}
            </span>
          </div>
          <h3 className="mt-1 text-lg leading-tight font-semibold">{displayTitle}</h3>
          {subtitle && <p className="text-muted-foreground text-sm">{subtitle}</p>}
          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
            <div>
              <span className="text-primary font-semibold">{playCount.toLocaleString()}</span>
              <span className="text-muted-foreground ml-1">
                {episodeCount ? 'episodes' : 'plays'}
              </span>
            </div>
            <div className="text-muted-foreground">{watchTimeHours.toLocaleString()}h watched</div>
            {bingeScore !== undefined && bingeScore > 0 && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="cursor-help">
                    <span className="font-semibold text-orange-500">{bingeScore.toFixed(1)}</span>
                    <span className="text-muted-foreground ml-1">binge score</span>
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="max-w-xs">
                  <p className="text-sm">
                    Measures binge-watching intensity based on viewing patterns: episode volume,
                    daily intensity, consecutive watches, and velocity. Higher scores indicate
                    stronger engagement.
                  </p>
                </TooltipContent>
              </Tooltip>
            )}
            {completionRate !== undefined && completionRate > 0 && (
              <div>
                <span className="font-semibold text-green-500">{completionRate}%</span>
                <span className="text-muted-foreground ml-1">completed</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
