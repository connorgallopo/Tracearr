/**
 * Session detail sheet - slide-out panel showing full session information.
 * Uses condensed info sections matching the app's design patterns.
 */

import { Link } from 'react-router';
import { MapContainer, TileLayer, CircleMarker } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import {
  Film,
  Tv,
  Music,
  Play,
  Pause,
  Square,
  MonitorPlay,
  Repeat2,
  Globe,
  Eye,
  Server,
  MapPin,
  Smartphone,
  Gauge,
  Clock,
  ExternalLink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { getAvatarUrl } from '@/components/users/utils';
import { useTheme } from '@/components/theme-provider';
import type {
  SessionWithDetails,
  ActiveSession,
  SessionState,
  MediaType,
  ServerType,
} from '@tracearr/shared';
import { format, formatDistanceToNow } from 'date-fns';

// Accept both SessionWithDetails (history) and ActiveSession (now playing)
// Both types have the same nested user/server structure
interface Props {
  session: SessionWithDetails | ActiveSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

// Server type configuration
const SERVER_CONFIG: Record<ServerType, { label: string; color: string }> = {
  plex: { label: 'Plex', color: 'text-amber-500' },
  jellyfin: { label: 'Jellyfin', color: 'text-purple-500' },
  emby: { label: 'Emby', color: 'text-green-500' },
};

// State configuration
const STATE_CONFIG: Record<SessionState, { icon: typeof Play; color: string; label: string }> = {
  playing: { icon: Play, color: 'text-green-500', label: 'Playing' },
  paused: { icon: Pause, color: 'text-yellow-500', label: 'Paused' },
  stopped: { icon: Square, color: 'text-muted-foreground', label: 'Stopped' },
};

// Media type configuration
const MEDIA_CONFIG: Record<MediaType, { icon: typeof Film; label: string }> = {
  movie: { icon: Film, label: 'Movie' },
  episode: { icon: Tv, label: 'Episode' },
  track: { icon: Music, label: 'Track' },
};

// Map tile URLs
const TILE_URLS = {
  dark: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
  light: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
};

// Format duration
function formatDuration(ms: number | null): string {
  if (!ms) return '—';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

// Format bitrate
function formatBitrate(bitrate: number | null): string {
  if (!bitrate) return '—';
  if (bitrate >= 1000) return `${(bitrate / 1000).toFixed(1)} Mbps`;
  return `${bitrate} Kbps`;
}

// Get progress percentage
function getProgress(session: SessionWithDetails): number {
  if (!session.totalDurationMs || session.totalDurationMs === 0) return 0;
  const progress = session.progressMs ?? session.durationMs ?? 0;
  return Math.min(100, Math.round((progress / session.totalDurationMs) * 100));
}

// Get media title formatted
function getMediaTitle(session: SessionWithDetails): { primary: string; secondary?: string } {
  if (session.mediaType === 'episode' && session.grandparentTitle) {
    const epNum =
      session.seasonNumber && session.episodeNumber
        ? `S${session.seasonNumber.toString().padStart(2, '0')}E${session.episodeNumber.toString().padStart(2, '0')}`
        : '';
    return {
      primary: session.grandparentTitle,
      secondary: `${epNum}${epNum ? ' · ' : ''}${session.mediaTitle}`,
    };
  }
  return {
    primary: session.mediaTitle,
    secondary: session.year ? `(${session.year})` : undefined,
  };
}

// Mini map component for session location
function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  const { theme } = useTheme();
  const resolvedTheme =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  const tileUrl = TILE_URLS[resolvedTheme];

  return (
    <div className="h-28 w-full overflow-hidden rounded-lg">
      <MapContainer
        center={[lat, lon]}
        zoom={10}
        className="h-full w-full"
        scrollWheelZoom={false}
        zoomControl={false}
        dragging={false}
        doubleClickZoom={false}
        attributionControl={false}
      >
        <TileLayer url={tileUrl} />
        <CircleMarker
          center={[lat, lon]}
          radius={8}
          pathOptions={{
            color: '#06b6d4',
            fillColor: '#22d3ee',
            fillOpacity: 0.8,
            weight: 2,
          }}
        />
      </MapContainer>
    </div>
  );
}

// Section container matching app's design
function Section({
  icon: Icon,
  title,
  badge,
  children,
}: {
  icon: typeof Server;
  title: string;
  badge?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <div className="bg-primary/10 flex h-6 w-6 items-center justify-center rounded-full">
            <Icon className="text-primary h-3.5 w-3.5" />
          </div>
          {title}
        </div>
        {badge}
      </div>
      {children}
    </div>
  );
}

export function SessionDetailSheet({ session, open, onOpenChange }: Props) {
  if (!session) return null;

  const serverConfig = SERVER_CONFIG[session.server.type];
  const stateConfig = STATE_CONFIG[session.state];
  const mediaConfig = MEDIA_CONFIG[session.mediaType];
  const MediaIcon = mediaConfig.icon;
  const title = getMediaTitle(session);
  const progress = getProgress(session);
  const hasLocation = session.geoLat && session.geoLon;

  // Get poster URL if available
  const posterUrl = session.thumbPath
    ? `/api/v1/images/proxy?server=${session.serverId}&url=${encodeURIComponent(session.thumbPath)}&width=120&height=180&fallback=poster`
    : null;

  // Build location string
  const locationParts = [session.geoCity, session.geoRegion, session.geoCountry].filter(Boolean);
  const locationString = locationParts.join(', ');

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader className="pb-4">
          <SheetTitle className="flex items-center gap-2 pr-8 text-base">
            <stateConfig.icon className={cn('h-4 w-4', stateConfig.color)} />
            Session Details
            <Badge
              variant={
                session.state === 'playing'
                  ? 'success'
                  : session.state === 'paused'
                    ? 'warning'
                    : 'secondary'
              }
              className="ml-auto"
            >
              {stateConfig.label}
            </Badge>
          </SheetTitle>
        </SheetHeader>

        <div className="space-y-3 px-1">
          {/* Media Info - Hero section */}
          <div className="flex gap-3 rounded-lg border p-3">
            {posterUrl && (
              <img
                src={posterUrl}
                alt={title.primary}
                className="h-20 w-14 flex-shrink-0 rounded object-cover"
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            )}
            <div className="min-w-0 flex-1">
              <div className="text-muted-foreground mb-1 flex items-center gap-1.5 text-xs">
                <MediaIcon className="h-3 w-3" />
                {mediaConfig.label}
                {session.year && <span>· {session.year}</span>}
              </div>
              <div className="flex items-center gap-1.5 leading-tight font-medium">
                <span className="truncate">{title.primary}</span>
                {session.watched && <Eye className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />}
              </div>
              {title.secondary && (
                <div className="text-muted-foreground mt-0.5 truncate text-sm">
                  {title.secondary}
                </div>
              )}
              {/* Progress inline */}
              <div className="mt-2 flex items-center gap-2">
                <Progress value={progress} className="h-1.5 flex-1" />
                <span className="text-muted-foreground w-8 text-xs">{progress}%</span>
              </div>
            </div>
          </div>

          {/* User */}
          <Link
            to={`/users/${session.serverUserId}`}
            className="hover:bg-muted/50 flex items-center gap-3 rounded-lg border p-3 transition-colors"
          >
            <Avatar className="h-9 w-9">
              <AvatarImage
                src={getAvatarUrl(session.serverId, session.user.thumbUrl, 36) ?? undefined}
              />
              <AvatarFallback>
                {(session.user.identityName ?? session.user.username)?.[0]?.toUpperCase() ?? '?'}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="truncate font-medium">
                {session.user.identityName ?? session.user.username}
              </p>
              {session.user.identityName && session.user.identityName !== session.user.username && (
                <p className="text-muted-foreground truncate text-xs">@{session.user.username}</p>
              )}
              {!session.user.identityName && (
                <p className="text-muted-foreground text-xs">View profile</p>
              )}
            </div>
            <ExternalLink className="text-muted-foreground h-4 w-4" />
          </Link>

          {/* Server */}
          <Section icon={Server} title="Server">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Server</span>
              <span className="flex items-center gap-1.5">
                <span className={serverConfig.color}>{serverConfig.label}</span>
                <span className="text-muted-foreground">·</span>
                {session.server.name}
              </span>
            </div>
          </Section>

          {/* Playback Info */}
          <Section
            icon={Clock}
            title="Playback"
            badge={
              'segmentCount' in session && session.segmentCount && session.segmentCount > 1 ? (
                <Badge variant="outline" className="text-xs">
                  {session.segmentCount} segments
                </Badge>
              ) : null
            }
          >
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Started</span>
                <span>
                  {format(new Date(session.startedAt), 'MMM d, h:mm a')}
                  <span className="text-muted-foreground ml-1.5 text-xs">
                    ({formatDistanceToNow(new Date(session.startedAt), { addSuffix: true })})
                  </span>
                </span>
              </div>
              {session.stoppedAt && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Stopped</span>
                  <span>{format(new Date(session.stoppedAt), 'MMM d, h:mm a')}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Watch time</span>
                <span>{formatDuration(session.durationMs)}</span>
              </div>
              {session.pausedDurationMs > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Paused</span>
                  <span>{formatDuration(session.pausedDurationMs)}</span>
                </div>
              )}
              {session.totalDurationMs && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Media length</span>
                  <span>{formatDuration(session.totalDurationMs)}</span>
                </div>
              )}
            </div>
          </Section>

          {/* Location & Network */}
          <Section icon={MapPin} title="Location">
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">IP Address</span>
                <span className="font-mono text-xs">{session.ipAddress || '—'}</span>
              </div>
              {locationString && (
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">Location</span>
                  <span className="flex items-center gap-1">
                    <Globe className="text-muted-foreground h-3 w-3" />
                    {locationString}
                  </span>
                </div>
              )}
              {hasLocation && <MiniMap lat={session.geoLat!} lon={session.geoLon!} />}
            </div>
          </Section>

          {/* Device */}
          <Section icon={Smartphone} title="Device">
            <div className="space-y-1.5 text-sm">
              {session.platform && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Platform</span>
                  <span>{session.platform}</span>
                </div>
              )}
              {session.product && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Product</span>
                  <span>{session.product}</span>
                </div>
              )}
              {session.device && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Device</span>
                  <span>{session.device}</span>
                </div>
              )}
              {session.playerName && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Player</span>
                  <span>{session.playerName}</span>
                </div>
              )}
              {session.deviceId && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Device ID</span>
                  <span className="max-w-[160px] truncate font-mono text-xs">
                    {session.deviceId}
                  </span>
                </div>
              )}
            </div>
          </Section>

          {/* Quality */}
          <Section
            icon={Gauge}
            title="Quality"
            badge={
              <Badge
                variant={session.isTranscode ? 'warning' : 'secondary'}
                className="gap-1 text-xs"
              >
                {session.isTranscode ? (
                  <>
                    <Repeat2 className="h-3 w-3" />
                    Transcode
                  </>
                ) : session.videoDecision === 'copy' || session.audioDecision === 'copy' ? (
                  <>
                    <MonitorPlay className="h-3 w-3" />
                    Direct Stream
                  </>
                ) : (
                  <>
                    <MonitorPlay className="h-3 w-3" />
                    Direct Play
                  </>
                )}
              </Badge>
            }
          >
            <div className="space-y-1.5 text-sm">
              {session.quality && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Quality</span>
                  <span>{session.quality}</span>
                </div>
              )}
              {session.videoDecision && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Video</span>
                  <span className="capitalize">
                    {session.videoDecision === 'directplay'
                      ? 'Direct Play'
                      : session.videoDecision === 'copy'
                        ? 'Direct Stream'
                        : 'Transcode'}
                  </span>
                </div>
              )}
              {session.audioDecision && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Audio</span>
                  <span className="capitalize">
                    {session.audioDecision === 'directplay'
                      ? 'Direct Play'
                      : session.audioDecision === 'copy'
                        ? 'Direct Stream'
                        : 'Transcode'}
                  </span>
                </div>
              )}
              {session.bitrate && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">Bitrate</span>
                  <span>{formatBitrate(session.bitrate)}</span>
                </div>
              )}
            </div>
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
