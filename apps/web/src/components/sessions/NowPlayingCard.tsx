import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Monitor, Smartphone, Tablet, Tv, Play, Pause, Server, Subtitles, X } from 'lucide-react';
import { getAvatarUrl } from '@/components/users/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import {
  cn,
  formatLocationCompact,
  getBufferedPercent,
  getDeviceDisplayName,
  getMediaDisplay,
  getMediaLinks,
} from '@/lib/utils';
import { imageProxyUrl } from '@/lib/api';
import { formatDate, formatDuration } from '@/lib/dateFormat';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { playbackBadge } from '@/lib/playbackBadge';
import { useEstimatedProgress } from '@/hooks/useEstimatedProgress';
import { useAuth } from '@/hooks/useAuth';
import { useServer } from '@/hooks/useServer';
import { ServerColorAccent } from '@/components/server';
import { TerminateSessionDialog } from './TerminateSessionDialog';
import { LocalBadge } from './LocalBadge';
import { MediaPageLink } from '@/components/media/MediaPageLink';
import {
  PLAYBACK_DECISION_LABEL_KEYS,
  POSTER_IMAGE_SIZE,
  type ActiveSession,
} from '@tracearr/shared';

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

export function NowPlayingCard({ session, onClick }: NowPlayingCardProps) {
  const { title, subtitle: mediaSubtitle } = getMediaDisplay(session);
  const mediaLinks = getMediaLinks(session);
  const { user } = useAuth();
  const { t } = useTranslation(['common', 'pages']);
  const subtitle =
    session.mediaType === 'trailer'
      ? [t('pages:automations.options.trailer'), mediaSubtitle].filter(Boolean).join(' · ')
      : mediaSubtitle;
  const { isMultiServer } = useServer();
  const [showTerminateDialog, setShowTerminateDialog] = useState(false);
  // Read when the tooltip opens: while playing, now plus what's left stays put.
  const [endsAt, setEndsAt] = useState<number | null>(null);

  // Only admin/owner can terminate sessions, and session must support termination
  // (some Plex clients like Plexamp don't provide the required Session.id)
  const canTerminate = (user?.role === 'admin' || user?.role === 'owner') && session.canTerminate;

  // Use estimated progress for smooth updates between SSE/poll events
  const { estimatedProgressMs, progressPercent } = useEstimatedProgress(session);

  // Time remaining based on estimated progress
  const remaining =
    session.totalDurationMs && estimatedProgressMs
      ? session.totalDurationMs - estimatedProgressMs
      : null;

  // Build poster URL using image proxy
  const posterUrl = session.thumbPath
    ? imageProxyUrl(
        session.serverId,
        session.thumbPath,
        POSTER_IMAGE_SIZE.width,
        POSTER_IMAGE_SIZE.height
      )
    : null;

  // User avatar URL (proxied for Jellyfin/Emby)
  const avatarUrl = getAvatarUrl(session.serverId, session.user.thumbUrl, 28) ?? undefined;

  const deviceName = getDeviceDisplayName(session);
  const isPaused = session.state === 'paused';
  const isSquareArt = session.mediaType === 'track' || session.mediaType === 'live';

  return (
    <>
      <ServerColorAccent
        serverId={session.serverId}
        onClick={onClick}
        className={cn(
          'group animate-fade-in bg-card card-hover relative overflow-hidden rounded-xl border',
          onClick && 'cursor-pointer'
        )}
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
                className={cn('h-full w-full', isSquareArt ? 'object-contain' : 'object-cover')}
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
              <div className="flex min-w-0 items-center gap-2">
                <Avatar className="border-background h-7 w-7 shrink-0 border-2 shadow">
                  <AvatarImage src={avatarUrl} alt={session.user.username} />
                  <AvatarFallback className="text-xs">
                    {session.user.username.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span
                  className="truncate text-sm font-medium"
                  title={session.user.identityName ?? session.user.username}
                >
                  {session.user.identityName ?? session.user.username}
                </span>
              </div>

              <div className="flex shrink-0 items-center gap-1.5">
                {/* Quality badge - icon only with tooltip */}
                {(() => {
                  const { decision, Icon, variant, isHwTranscode, isBurnIn } =
                    playbackBadge(session);
                  const label = isHwTranscode
                    ? t('playback.hwTranscode')
                    : t(PLAYBACK_DECISION_LABEL_KEYS[decision]);

                  return (
                    <span
                      className={cn(
                        'relative flex h-6 w-6 items-center justify-center',
                        variant === 'warning' ? 'text-warning' : 'text-success'
                      )}
                      title={isBurnIn ? `${label} · ${t('playback.burnIn')}` : label}
                    >
                      <Icon className="h-4 w-4" />
                      {isBurnIn && (
                        <span className="bg-card absolute -right-1 -bottom-1 flex h-3.5 w-3.5 items-center justify-center rounded-full">
                          <Subtitles className="text-warning h-2.5 w-2.5" />
                        </span>
                      )}
                    </span>
                  );
                })()}

                {/* Device icon - names the client on hover, like the quality badge */}
                <div
                  className="flex h-6 w-6 items-center justify-center"
                  title={deviceName ?? undefined}
                  data-testid="device-icon"
                >
                  <DeviceIcon session={session} className="text-muted-foreground h-4 w-4" />
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
                    title={t('pages:terminateStream.title')}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                )}
              </div>
            </div>

            {/* Middle: Title */}
            <div className="mt-2">
              <h3 className="truncate text-sm leading-tight font-semibold">
                <MediaPageLink to={mediaLinks.title}>{title}</MediaPageLink>
              </h3>
              {subtitle && (
                <p className="text-muted-foreground mt-0.5 truncate text-xs">
                  <MediaPageLink to={mediaLinks.subtitle}>{subtitle}</MediaPageLink>
                </p>
              )}
            </div>

            {/* Bottom: Progress */}
            <div className="mt-3 space-y-1">
              <Progress
                value={progressPercent}
                buffered={getBufferedPercent(session)}
                className="h-1.5"
              />
              <div className="text-muted-foreground flex justify-between text-[10px]">
                <span>{formatDuration(estimatedProgressMs)}</span>
                <span>
                  {isPaused || session.buffering ? (
                    <span className="font-medium text-yellow-500">
                      {session.buffering ? t('playback.buffering') : t('playback.paused')}
                    </span>
                  ) : remaining ? (
                    <TooltipProvider delayDuration={100}>
                      <Tooltip
                        onOpenChange={(open) => {
                          if (open) setEndsAt(Date.now() + remaining);
                        }}
                      >
                        <TooltipTrigger asChild>
                          <span>-{formatDuration(remaining)}</span>
                        </TooltipTrigger>
                        {endsAt !== null && (
                          <TooltipContent>
                            {t('playback.endsAt', {
                              time: formatDate(endsAt, { hour: 'numeric', minute: '2-digit' }),
                            })}
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    formatDuration(session.totalDurationMs)
                  )}
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Location/Quality footer */}
        <div className="bg-muted/50 text-muted-foreground relative flex items-center justify-between gap-2 border-t px-4 py-2 text-xs">
          <span className="flex min-w-0 items-center gap-1.5">
            {isMultiServer && session.server && (
              <>
                <span className="shrink-0">{session.server.name}</span>
                <span className="text-muted-foreground/50">·</span>
              </>
            )}
            <span className="truncate">
              {formatLocationCompact(session.geoCity, session.geoRegion, session.geoCountry) ??
                t('pages:dashboard.unknownLocation')}
            </span>
            <LocalBadge isLocal={session.isLocal} country={session.geoCountry} />
          </span>
          <span className="flex-shrink-0">
            {session.quality ?? t('pages:dashboard.unknownQuality')}
          </span>
        </div>
      </ServerColorAccent>

      {/* Terminate confirmation dialog */}
      <TerminateSessionDialog
        open={showTerminateDialog}
        onOpenChange={setShowTerminateDialog}
        sessionId={session.id}
        mediaTitle={title}
        username={session.user.username}
      />
    </>
  );
}
