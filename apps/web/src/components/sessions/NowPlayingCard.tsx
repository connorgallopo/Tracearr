import { useState } from 'react';
import { Monitor, Smartphone, Tablet, Tv, Server, X } from 'lucide-react';
import {
  formatAudioChannels,
  formatEpisodeLabel,
  formatMediaTech,
  getResolutionLabel,
  type ActiveSession,
} from '@tracearr/shared';
import { getAvatarUrl } from '@/components/users/utils';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { imageProxyUrl } from '@/lib/api';
import { formatDuration } from '@/lib/formatters';
import { useEstimatedProgress } from '@/hooks/useEstimatedProgress';
import { useAuth } from '@/hooks/useAuth';
import { useServerColorMap } from '@/hooks/useServerColorMap';
import { ServerColorAccent } from '@/components/server';
import { TerminateSessionDialog } from './TerminateSessionDialog';

interface NowPlayingCardProps {
  session: ActiveSession;
  onClick?: () => void;
}

export type StreamMode = 'transcode' | 'directStream' | 'directPlay';

export function getStreamMode(session: ActiveSession): StreamMode {
  if (session.isTranscode) return 'transcode';
  if (session.videoDecision === 'copy' || session.audioDecision === 'copy') return 'directStream';
  return 'directPlay';
}

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

function decisionLabel(decision: string | null | undefined): string {
  switch (decision) {
    case 'directplay':
      return 'Direct Play';
    case 'copy':
      return 'Direct Stream';
    case 'transcode':
      return 'Transcode';
    case 'burn':
      return 'Burn';
    default:
      return 'Unknown';
  }
}

function streamModeLabel(session: ActiveSession): string {
  const mode = getStreamMode(session);
  if (mode === 'directPlay') return 'Direct Play';
  if (mode === 'directStream') return 'Direct Stream';

  const hardware = !!(session.transcodeInfo?.hwEncoding || session.transcodeInfo?.hwDecoding);
  const target: 'Video' | 'Audio' | 'Subtitles' | null =
    session.videoDecision === 'transcode'
      ? 'Video'
      : session.audioDecision === 'transcode'
        ? 'Audio'
        : session.subtitleInfo?.decision === 'burn' ||
            session.subtitleInfo?.decision === 'transcode'
          ? 'Subtitles'
          : null;
  const label = hardware ? 'HW Transcode' : 'Transcode';
  return target ? `${label} · ${target}` : label;
}

function formatVideoDetail(session: ActiveSession): string {
  const sourceCodec = session.sourceVideoCodec ? formatMediaTech(session.sourceVideoCodec) : null;
  const outputCodec = session.streamVideoCodec
    ? formatMediaTech(session.streamVideoCodec)
    : sourceCodec;
  const sourceResolution = getResolutionLabel(session.sourceVideoWidth, session.sourceVideoHeight);
  const outputResolution =
    getResolutionLabel(session.streamVideoDetails?.width, session.streamVideoDetails?.height) ??
    sourceResolution;

  if (session.videoDecision === 'transcode' && (sourceCodec || sourceResolution)) {
    const source = [sourceCodec, sourceResolution].filter(Boolean).join(' ');
    const output = [outputCodec, outputResolution].filter(Boolean).join(' ');
    if (source && output) return `${source} → ${output}`;
  }

  const format = [outputCodec, outputResolution].filter(Boolean).join(' ');
  return [decisionLabel(session.videoDecision), format].filter(Boolean).join(' · ');
}

function formatAudioDetail(session: ActiveSession): string {
  const sourceCodec = session.sourceAudioCodec ? formatMediaTech(session.sourceAudioCodec) : null;
  const outputCodec = session.streamAudioCodec
    ? formatMediaTech(session.streamAudioCodec)
    : sourceCodec;
  const sourceChannels = formatAudioChannels(session.sourceAudioChannels);
  const outputChannels =
    formatAudioChannels(session.streamAudioDetails?.channels) ?? sourceChannels;

  if (session.audioDecision === 'transcode' && (sourceCodec || sourceChannels)) {
    const source = [sourceCodec, sourceChannels].filter(Boolean).join(' ');
    const output = [outputCodec, outputChannels].filter(Boolean).join(' ');
    if (source && output) return `${source} → ${output}`;
  }

  const format = [outputCodec, outputChannels].filter(Boolean).join(' ');
  return [decisionLabel(session.audioDecision), format].filter(Boolean).join(' · ');
}

function formatSubtitleDetail(session: ActiveSession): string {
  const subtitle = session.subtitleInfo;
  if (!subtitle?.decision && !subtitle?.codec && !subtitle?.language) return 'None';
  return [
    subtitle.decision ? decisionLabel(subtitle.decision) : null,
    subtitle.codec ? formatMediaTech(subtitle.codec) : null,
    subtitle.language,
  ]
    .filter(Boolean)
    .join(' · ');
}

function formatBandwidth(bitrate: number | null): string {
  return bitrate && bitrate > 0 ? `~${(bitrate / 1000).toFixed(1)} Mbps` : 'Unknown';
}

function mediaDisplay(session: ActiveSession) {
  if (session.mediaType === 'episode') {
    return {
      title: session.grandparentTitle ?? session.mediaTitle,
      subtitle: session.mediaTitle,
      meta:
        formatEpisodeLabel(session.seasonNumber, session.episodeNumber, { spaced: true }) ?? '—',
    };
  }
  if (session.mediaType === 'track') {
    return {
      title: session.mediaTitle,
      subtitle: [session.artistName, session.albumName].filter(Boolean).join(' · ') || null,
      meta: session.year ? String(session.year) : '—',
    };
  }
  return {
    title: session.mediaTitle,
    subtitle: null,
    meta: session.year ? String(session.year) : '—',
  };
}

const MODE_STYLES: Record<StreamMode, string> = {
  transcode: 'border-yellow-500/30 bg-yellow-500/10 text-yellow-600 dark:text-yellow-400',
  directStream: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-400',
  directPlay: 'border-green-500/30 bg-green-500/10 text-green-600 dark:text-green-400',
};

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid min-h-5 grid-cols-[4rem_minmax(0,1fr)] items-baseline gap-2">
      <span className="text-muted-foreground text-right text-[10px] leading-4 font-medium tracking-[0.04em] uppercase">
        {label}
      </span>
      <span className="truncate text-xs leading-4" title={value}>
        {value}
      </span>
    </div>
  );
}

export function NowPlayingCard({ session, onClick }: NowPlayingCardProps) {
  const display = mediaDisplay(session);
  const { user } = useAuth();
  const serverColor = useServerColorMap().get(session.serverId) ?? undefined;
  const [showTerminateDialog, setShowTerminateDialog] = useState(false);
  const canTerminate = (user?.role === 'admin' || user?.role === 'owner') && session.canTerminate;
  const { estimatedProgressMs, progressPercent } = useEstimatedProgress(session);
  const remaining = session.totalDurationMs
    ? Math.max(0, session.totalDurationMs - estimatedProgressMs)
    : null;
  const posterUrl = session.thumbPath
    ? imageProxyUrl(session.serverId, session.thumbPath, 200, 300)
    : null;
  const avatarUrl = getAvatarUrl(session.serverId, session.user.thumbUrl, 28) ?? undefined;
  const mode = getStreamMode(session);
  const modeLabel = streamModeLabel(session);
  const deviceLabel = session.device ?? session.platform ?? session.product;
  const location =
    [session.geoCity, session.geoRegion].filter(Boolean).join(', ') || session.geoCountry;
  const locationAndIp = [location, session.ipAddress].filter(Boolean).join(' · ') || 'Unknown';
  const isPaused = session.state === 'paused';
  const isSquareArt = session.mediaType === 'track' || session.mediaType === 'live';

  return (
    <>
      <ServerColorAccent
        serverId={session.serverId}
        onClick={onClick}
        className={cn(
          'group animate-fade-in bg-card card-hover relative overflow-hidden rounded-lg border',
          onClick && 'cursor-pointer'
        )}
      >
        {posterUrl && (
          <div
            className="absolute inset-0 bg-cover bg-center opacity-[0.06] blur-2xl"
            style={{ backgroundImage: `url(${posterUrl})` }}
          />
        )}

        <div className="relative flex h-10 items-center justify-between gap-2 border-b px-3">
          <div className="flex min-w-0 items-center gap-2">
            <Avatar className="border-background h-6 w-6 shrink-0 border shadow">
              <AvatarImage src={avatarUrl} alt={session.user.username} />
              <AvatarFallback className="text-[10px]">
                {session.user.username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <span
              className="truncate text-xs font-semibold"
              title={session.user.identityName ?? session.user.username}
            >
              {session.user.identityName ?? session.user.username}
            </span>
            {deviceLabel && (
              <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-[10px]">
                <DeviceIcon session={session} className="h-3 w-3 shrink-0" />
                <span className="truncate">{deviceLabel}</span>
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-1">
            <Badge
              variant="outline"
              className={cn('h-5 px-2 text-[10px] leading-none font-semibold', MODE_STYLES[mode])}
            >
              {modeLabel}
            </Badge>
            {canTerminate && (
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive h-6 w-6"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowTerminateDialog(true);
                }}
                aria-label="Terminate stream"
                title="Terminate stream"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>

        <div className="relative grid min-h-40 grid-cols-[5rem_minmax(0,1fr)] gap-3 px-3 py-2.5">
          <div className="bg-muted h-[8.25rem] w-20 overflow-hidden rounded-md shadow-lg">
            {posterUrl ? (
              <img
                src={posterUrl}
                alt={display.title}
                className={cn('h-full w-full', isSquareArt ? 'object-contain' : 'object-cover')}
                loading="lazy"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center">
                <Server className="text-muted-foreground h-7 w-7" />
              </div>
            )}
          </div>

          <div className="min-w-0">
            <div className="flex items-baseline justify-between gap-2 border-b pb-1.5">
              <h3 className="truncate text-xs leading-4 font-semibold" title={display.title}>
                {display.title}
              </h3>
              <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                {display.meta}
              </span>
            </div>
            <p
              className="text-muted-foreground h-5 truncate pt-0.5 text-[10px] leading-4"
              aria-hidden={!display.subtitle}
              title={display.subtitle ?? undefined}
            >
              {display.subtitle ?? '\u00A0'}
            </p>
            <DetailRow label="Stream" value={modeLabel} />
            <DetailRow label="Video" value={formatVideoDetail(session)} />
            <DetailRow label="Audio" value={formatAudioDetail(session)} />
            <DetailRow label="Subtitles" value={formatSubtitleDetail(session)} />
            <DetailRow label="Location" value={locationAndIp} />
            <DetailRow label="Bandwidth" value={formatBandwidth(session.bitrate)} />
          </div>
        </div>

        <div
          role="progressbar"
          aria-label={`${display.title} playback progress`}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progressPercent)}
          className="bg-muted relative h-1 w-full overflow-hidden"
        >
          <div
            className="h-full transition-[width]"
            style={{
              width: `${Math.min(100, Math.max(0, progressPercent))}%`,
              backgroundColor: serverColor ?? 'hsl(var(--primary))',
            }}
          />
        </div>

        <footer className="bg-muted/50 text-muted-foreground relative flex h-8 items-center justify-between gap-2 border-t px-3 text-[10px]">
          <span className="flex min-w-0 items-center gap-1.5 text-xs">
            <span
              className="bg-primary h-1.5 w-1.5 shrink-0 rounded-full"
              style={serverColor ? { backgroundColor: serverColor } : undefined}
            />
            <span className="truncate">{session.server.name}</span>
          </span>
          <span className="flex shrink-0 items-center gap-2 tabular-nums">
            <span>{formatDuration(estimatedProgressMs)}</span>
            {isPaused ? (
              <span className="font-medium text-yellow-500">Paused</span>
            ) : remaining !== null ? (
              <span>−{formatDuration(remaining)}</span>
            ) : (
              <span>{formatDuration(session.totalDurationMs)}</span>
            )}
          </span>
        </footer>
      </ServerColorAccent>

      <TerminateSessionDialog
        open={showTerminateDialog}
        onOpenChange={setShowTerminateDialog}
        sessionId={session.id}
        mediaTitle={display.title}
        username={session.user.username}
      />
    </>
  );
}
