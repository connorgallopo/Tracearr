import { useState } from 'react';
import { Monitor, Smartphone, Tablet, Tv, Play, Pause, Zap, Server, X } from 'lucide-react';
import { getAvatarUrl } from '@/components/users/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import { useEstimatedProgress } from '@/hooks/useEstimatedProgress';
import { useAuth } from '@/hooks/useAuth';
import { TerminateSessionDialog } from './TerminateSessionDialog';
import type { ActiveSession } from '@tracearr/shared';

interface NowPlayingCardProps {
  session: ActiveSession;
  onClick?: () => void;
}

// Get device icon based on platform/device info
function DeviceIcon({ session, className }: { session: ActiveSession; className?: string }) {
  const platform = session.platform?.toLowerCase() ?? '';
  const device = session.device?.toLowerCase() ?? '';
  const product = session.product?.toLowerCase() ?? '';

  if (platform.includes('ios') || device.includes('iphone') || platform.includes('android')) {
    return <Smartphone className={className} />;
  }
  if (device.includes('ipad') || platform.includes('tablet')) {
    return <Tablet className={className} />;
  }
  if (
    platform.includes('tv') ||
    device.includes('tv') ||
    product.includes('tv') ||
    device.includes('roku') ||
    device.includes('firestick') ||
    device.includes('chromecast') ||
    device.includes('apple tv') ||
    device.includes('shield')
  ) {
    return <Tv className={className} />;
  }
  return <Monitor className={className} />;
}

// Format duration for display
function formatDuration(ms: number | null): string {
  if (!ms) return '--:--';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

// Get display title for media
function getMediaDisplay(session: ActiveSession): { title: string; subtitle: string | null } {
  if (session.mediaType === 'episode' && session.grandparentTitle) {
    // TV Show episode
    const episodeInfo =
      session.seasonNumber && session.episodeNumber
        ? `S${session.seasonNumber.toString().padStart(2, '0')}E${session.episodeNumber.toString().padStart(2, '0')}`
        : '';
    return {
      title: session.grandparentTitle,
      subtitle: episodeInfo ? `${episodeInfo} · ${session.mediaTitle}` : session.mediaTitle,
    };
  }
  // Movie or music
  return {
    title: session.mediaTitle,
    subtitle: session.year ? `${session.year}` : null,
  };
}

export function NowPlayingCard({ session, onClick }: NowPlayingCardProps) {
  const { title, subtitle } = getMediaDisplay(session);
  const { user } = useAuth();
  const [showTerminateDialog, setShowTerminateDialog] = useState(false);

  // Only admin/owner can terminate sessions
  const canTerminate = user?.role === 'admin' || user?.role === 'owner';

  // Use estimated progress for smooth updates between SSE/poll events
  const { estimatedProgressMs, progressPercent } = useEstimatedProgress(session);

  // Time remaining based on estimated progress
  const remaining =
    session.totalDurationMs && estimatedProgressMs
      ? session.totalDurationMs - estimatedProgressMs
      : null;

  // Build poster URL using image proxy
  const posterUrl = session.thumbPath
    ? `/api/v1/images/proxy?server=${session.serverId}&url=${encodeURIComponent(session.thumbPath)}&width=200&height=300`
    : null;

  // User avatar URL (proxied for Jellyfin/Emby)
  const avatarUrl = getAvatarUrl(session.serverId, session.user.thumbUrl, 28) ?? undefined;

  const isPaused = session.state === 'paused';

  return (
    <div
      className={cn(
        'group animate-fade-in bg-card hover:shadow-primary/10 relative overflow-hidden rounded-xl border transition-all duration-300 hover:scale-[1.02] hover:shadow-lg',
        onClick && 'cursor-pointer'
      )}
      onClick={onClick}
    >
      {/* Background with poster blur */}
      {posterUrl && (
        <div
          className="absolute inset-0 bg-cover bg-center opacity-20 blur-xl"
          style={{ backgroundImage: `url(${posterUrl})` }}
        />
      )}

      {/* Content */}
      <div className="relative flex gap-4 p-4">
        {/* Poster */}
        <div className="bg-muted relative h-28 w-20 flex-shrink-0 overflow-hidden rounded-lg shadow-lg">
          {posterUrl ? (
            <img
              src={posterUrl}
              alt={title}
              className="h-full w-full object-cover"
              loading="lazy"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center">
              <Server className="text-muted-foreground h-8 w-8" />
            </div>
          )}

          {/* Play/Pause indicator overlay */}
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center bg-black/50 transition-opacity',
              isPaused ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            {isPaused ? (
              <Pause className="h-8 w-8 text-white" />
            ) : (
              <Play className="h-8 w-8 text-white" />
            )}
          </div>
        </div>

        {/* Info */}
        <div className="flex min-w-0 flex-1 flex-col justify-between">
          {/* Top row: User and badges */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <Avatar className="border-background h-7 w-7 border-2 shadow">
                <AvatarImage src={avatarUrl} alt={session.user.username} />
                <AvatarFallback className="text-xs">
                  {session.user.username.slice(0, 2).toUpperCase()}
                </AvatarFallback>
              </Avatar>
              <span className="text-sm font-medium">
                {session.user.identityName ?? session.user.username}
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              {/* Quality badge */}
              <Badge
                variant={session.isTranscode ? 'secondary' : 'default'}
                className={cn('text-xs', !session.isTranscode && 'bg-green-600 hover:bg-green-700')}
              >
                {session.isTranscode ? (
                  <>
                    <Zap className="mr-1 h-3 w-3" />
                    Transcode
                  </>
                ) : session.videoDecision === 'copy' || session.audioDecision === 'copy' ? (
                  'Direct Stream'
                ) : (
                  'Direct Play'
                )}
              </Badge>

              {/* Device icon */}
              <div className="bg-muted flex h-6 w-6 items-center justify-center rounded-md">
                <DeviceIcon session={session} className="text-muted-foreground h-3.5 w-3.5" />
              </div>

              {/* Terminate button - admin/owner only */}
              {canTerminate && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive h-6 w-6"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowTerminateDialog(true);
                  }}
                  title="Terminate stream"
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              )}
            </div>
          </div>

          {/* Middle: Title */}
          <div className="mt-2">
            <h3 className="truncate text-sm leading-tight font-semibold">{title}</h3>
            {subtitle && (
              <p className="text-muted-foreground mt-0.5 truncate text-xs">{subtitle}</p>
            )}
          </div>

          {/* Bottom: Progress */}
          <div className="mt-3 space-y-1">
            <Progress value={progressPercent} className="h-1.5" />
            <div className="text-muted-foreground flex justify-between text-[10px]">
              <span>{formatDuration(estimatedProgressMs)}</span>
              <span>
                {isPaused ? (
                  <span className="font-medium text-yellow-500">Paused</span>
                ) : remaining ? (
                  `-${formatDuration(remaining)}`
                ) : (
                  formatDuration(session.totalDurationMs)
                )}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Location/Quality footer */}
      <div className="bg-muted/50 text-muted-foreground relative flex items-center justify-between border-t px-4 py-2 text-xs">
        <span className="truncate">
          {session.geoCity && session.geoCountry
            ? `${session.geoCity}, ${session.geoCountry}`
            : (session.geoCountry ?? 'Unknown location')}
        </span>
        <span className="flex-shrink-0">{session.quality ?? 'Unknown quality'}</span>
      </div>

      {/* Terminate confirmation dialog */}
      <TerminateSessionDialog
        open={showTerminateDialog}
        onOpenChange={setShowTerminateDialog}
        sessionId={session.id}
        mediaTitle={title}
        username={session.user.username}
      />
    </div>
  );
}
