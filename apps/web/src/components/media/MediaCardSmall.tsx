import { Film, Tv, Music } from 'lucide-react';
import { cn } from '@/lib/utils';

interface MediaCardSmallProps {
  title: string;
  type: string;
  showTitle?: string | null;
  year?: number | null;
  playCount: number;
  thumbPath?: string | null;
  serverId?: string | null;
  rank?: number;
  className?: string;
  style?: React.CSSProperties;
  /** For TV shows (aggregated series), number of unique episodes watched */
  episodeCount?: number;
}

function MediaIcon({ type, className }: { type: string; className?: string }) {
  switch (type) {
    case 'movie':
      return <Film className={className} />;
    case 'episode':
      return <Tv className={className} />;
    case 'track':
      return <Music className={className} />;
    default:
      return <Film className={className} />;
  }
}

function getImageUrl(
  serverId: string | null | undefined,
  thumbPath: string | null | undefined,
  width = 150,
  height = 225
) {
  if (!serverId || !thumbPath) return null;
  return `/api/v1/images/proxy?server=${serverId}&url=${encodeURIComponent(thumbPath)}&width=${width}&height=${height}&fallback=poster`;
}

export function MediaCardSmall({
  title,
  type,
  showTitle,
  year,
  playCount,
  thumbPath,
  serverId,
  rank,
  className,
  style,
  episodeCount,
}: MediaCardSmallProps) {
  const imageUrl = getImageUrl(serverId, thumbPath);
  // For individual episodes: showTitle is series name, title is episode name
  // For aggregated shows: title is series name (no showTitle), episodeCount indicates it's aggregated
  const displayTitle = type === 'episode' && showTitle ? showTitle : title;

  return (
    <div
      className={cn(
        'group animate-fade-in bg-card hover:border-primary/50 hover:shadow-primary/10 relative overflow-hidden rounded-lg border transition-all duration-300 hover:scale-[1.03] hover:shadow-lg',
        className
      )}
      style={style}
    >
      {/* Poster */}
      <div className="bg-muted relative aspect-[2/3] overflow-hidden">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={displayTitle}
            className="h-full w-full object-cover transition-transform group-hover:scale-105"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <MediaIcon type={type} className="text-muted-foreground/50 h-12 w-12" />
          </div>
        )}

        {/* Rank badge */}
        {rank && (
          <div className="absolute top-2 left-2 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-xs font-bold text-white">
            {rank}
          </div>
        )}

        {/* Hover overlay with play count */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/60 opacity-0 transition-opacity group-hover:opacity-100">
          <div className="text-center">
            <div className="text-2xl font-bold text-white">{playCount}</div>
            <div className="text-xs text-white/80">plays</div>
          </div>
        </div>
      </div>

      {/* Info */}
      <div className="p-3">
        <h4 className="truncate text-sm font-medium" title={displayTitle}>
          {displayTitle}
        </h4>
        <p className="text-muted-foreground truncate text-xs">
          {episodeCount ? `${episodeCount} eps` : type === 'episode' ? title : year || type}
        </p>
      </div>
    </div>
  );
}
