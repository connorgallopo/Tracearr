/**
 * Session detail sheet - slide-out panel showing full session information.
 * Uses condensed info sections matching the app's design patterns.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { MapContainer, TileLayer, CircleMarker } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Separator } from '@/components/ui/separator';
import {
  Film,
  Tv,
  Music,
  Radio,
  Image,
  CircleHelp,
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
  ChevronDown,
  Clapperboard,
} from 'lucide-react';
import { cn, getCountryName, getMediaDisplay } from '@/lib/utils';
import { getAvatarUrl } from '@/components/users/utils';
import { useTheme } from '@/components/theme-provider';
import { StreamDetailsPanel } from './StreamDetailsPanel';

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
  live: { icon: Radio, label: 'Live TV' },
  photo: { icon: Image, label: 'Photo' },
  trailer: { icon: Clapperboard, label: 'Trailer' },
  unknown: { icon: CircleHelp, label: 'Unknown' },
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

// Format transcode reason codes into human-friendly labels
function formatReason(reason: string): string {
  return reason
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

// Get watch time - for active sessions (durationMs is null), calculate from elapsed time
function getWatchTime(session: SessionWithDetails | ActiveSession): number | null {
  // If we have a recorded duration, use it
  if (session.durationMs !== null) {
    return session.durationMs;
  }

  // For active sessions, calculate elapsed time minus paused time
  const startTime = new Date(session.startedAt).getTime();
  const now = Date.now();
  const elapsedMs = now - startTime;
  const pausedMs = session.pausedDurationMs ?? 0;

  return Math.max(0, elapsedMs - pausedMs);
}

// Get progress percentage (playback position)
// Uses progressMs (where in the video) not durationMs (how long watched)
function getProgress(session: SessionWithDetails): number {
  if (!session.totalDurationMs || session.totalDurationMs === 0) return 0;
  const progress = session.progressMs ?? 0;
  return Math.min(100, Math.round((progress / session.totalDurationMs) * 100));
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
  const [locationOpen, setLocationOpen] = useState(false);

  if (!session) return null;

  const serverConfig = SERVER_CONFIG[session.server.type];
  const stateConfig = STATE_CONFIG[session.state];
  const mediaConfig = MEDIA_CONFIG[session.mediaType];
  const MediaIcon = mediaConfig.icon;
  const { title: primary, subtitle: secondary } = getMediaDisplay(session);
  const progress = getProgress(session);
  const hasLocation = session.geoLat !== null && session.geoLon !== null;
  const geoCountryName = getCountryName(session.geoCountry);
  const geoCoordinates =
    session.geoLat !== null && session.geoLon !== null
      ? `${session.geoLat.toFixed(4)}, ${session.geoLon.toFixed(4)}`
      : null;
  const geoAsnNumber = session.geoAsnNumber ? `AS${session.geoAsnNumber}` : null;

  // Get poster URL if available
  const posterUrl = session.thumbPath
    ? `/api/v1/images/proxy?server=${session.serverId}&url=${encodeURIComponent(session.thumbPath)}&width=120&height=180&fallback=poster`
    : null;

  // Build location string
  const locationParts = [session.geoCity, session.geoRegion, geoCountryName].filter(Boolean);
  const locationString = locationParts.join(', ');
  const transcodeReasons = session.transcodeInfo?.reasons ?? [];
  const hasTranscodeReason = transcodeReasons.length > 0;
  const transcodeReasonText = transcodeReasons.map(formatReason).join(', ');

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
                alt={primary}
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
                <span className="truncate">{primary}</span>
                {session.watched && <Eye className="h-3.5 w-3.5 flex-shrink-0 text-green-500" />}
              </div>
              {secondary && (
                <div className="text-muted-foreground mt-0.5 truncate text-sm">{secondary}</div>
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
                <span>{formatDuration(getWatchTime(session))}</span>
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
            <Collapsible open={locationOpen} onOpenChange={setLocationOpen} className="space-y-2">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="hover:text-foreground flex w-full items-center justify-between text-sm transition-colors"
                >
                  <span className="text-muted-foreground">IP Address</span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono text-xs">{session.ipAddress || '—'}</span>
                    <ChevronDown
                      className={cn(
                        'text-muted-foreground h-3.5 w-3.5 transition-transform',
                        locationOpen && 'rotate-180'
                      )}
                    />
                  </span>
                </button>
              </CollapsibleTrigger>
              {hasLocation && <MiniMap lat={session.geoLat!} lon={session.geoLon!} />}
              {locationString && (
                <div className="flex items-center gap-1.5 text-sm">
                  <Globe className="text-muted-foreground h-3.5 w-3.5 flex-shrink-0" />
                  <span>{locationString}</span>
                </div>
              )}
              <CollapsibleContent className="space-y-2">
                <div className="space-y-1.5 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Continent</span>
                    <span>{session.geoContinent ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Country</span>
                    <span>{geoCountryName ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Region</span>
                    <span>{session.geoRegion ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">City</span>
                    <span>{session.geoCity ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Postal Code</span>
                    <span>{session.geoPostal ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">Coordinates</span>
                    <span className="font-mono text-xs">{geoCoordinates ?? '—'}</span>
                  </div>
                  <Separator className="my-2" />
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">ASN</span>
                    <span>{geoAsnNumber ?? '—'}</span>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-muted-foreground">ASN Org</span>
                    <span className="max-w-[180px] truncate text-right">
                      {session.geoAsnOrganization ?? '—'}
                    </span>
                  </div>
                </div>
              </CollapsibleContent>
            </Collapsible>
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

          {/* Stream Details */}
          <Section
            icon={Gauge}
            title="Stream Details"
            badge={
              <Badge
                variant={session.isTranscode ? 'warning' : 'secondary'}
                className="gap-1 text-xs"
              >
                {session.isTranscode ? (
                  hasTranscodeReason ? (
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="flex items-center gap-1">
                            <Repeat2 className="h-3 w-3" />
                            Transcode
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="max-w-xs text-left">
                          <span className="text-[11px]">{transcodeReasonText}</span>
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  ) : (
                    <>
                      <Repeat2 className="h-3 w-3" />
                      Transcode
                    </>
                  )
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
            <StreamDetailsPanel
              sourceVideoCodec={session.sourceVideoCodec ?? null}
              sourceAudioCodec={session.sourceAudioCodec ?? null}
              sourceAudioChannels={session.sourceAudioChannels ?? null}
              sourceVideoWidth={session.sourceVideoWidth ?? null}
              sourceVideoHeight={session.sourceVideoHeight ?? null}
              streamVideoCodec={session.streamVideoCodec ?? null}
              streamAudioCodec={session.streamAudioCodec ?? null}
              sourceVideoDetails={session.sourceVideoDetails ?? null}
              sourceAudioDetails={session.sourceAudioDetails ?? null}
              streamVideoDetails={session.streamVideoDetails ?? null}
              streamAudioDetails={session.streamAudioDetails ?? null}
              transcodeInfo={session.transcodeInfo ?? null}
              subtitleInfo={session.subtitleInfo ?? null}
              videoDecision={session.videoDecision ?? null}
              audioDecision={session.audioDecision ?? null}
              bitrate={session.bitrate ?? null}
              serverType={session.server.type}
            />
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}
