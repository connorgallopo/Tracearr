/**
 * Session detail sheet - slide-out panel showing full session information.
 * Uses condensed info sections matching the app's design patterns.
 */

import { lazy, memo, Suspense, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/hooks/useAuth';
import { Link } from 'react-router';
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
  Globe,
  Eye,
  Server,
  MapPin,
  Smartphone,
  Gauge,
  Clock,
  ExternalLink,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  Subtitles,
} from 'lucide-react';
import {
  cn,
  getCountryName,
  getMediaDisplay,
  getMediaLinks,
  getSessionProgress,
} from '@/lib/utils';
import { imageProxyUrl } from '@/lib/api';
import { playbackBadge } from '@/lib/playbackBadge';
import { DATE_TIME_OPTIONS, formatDate, formatDuration } from '@/lib/dateFormat';
import { getAvatarUrl } from '@/components/users/utils';
import { LocalBadge } from '@/components/sessions/LocalBadge';
import { MediaPageLink } from '@/components/media/MediaPageLink';
import { StreamDetailsPanel } from './StreamDetailsPanel';

import {
  PLAYBACK_DECISION_LABEL_KEYS,
  POSTER_IMAGE_SIZE,
  SERVER_PROFILES,
  SERVER_TYPE_BRAND_COLORS,
  isStaff,
  verbKeysFor,
} from '@tracearr/shared';
import type {
  SessionWithDetails,
  ActiveSession,
  SessionSegment,
  SessionState,
  MediaType,
} from '@tracearr/shared';
import { formatDistanceToNow } from 'date-fns';

// Accept both SessionWithDetails (history) and ActiveSession (now playing)
// Both types have the same nested user/server structure
interface Props {
  session: SessionWithDetails | ActiveSession | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const STATE_CONFIG = {
  playing: { icon: Play, color: 'text-success', labelKey: 'common:playback.playing' },
  paused: { icon: Pause, color: 'text-warning', labelKey: 'common:playback.paused' },
  stopped: { icon: Square, color: 'text-muted-foreground', labelKey: 'common:playback.stopped' },
} as const satisfies Record<SessionState, { icon: typeof Play; color: string; labelKey: string }>;

const MEDIA_CONFIG = {
  movie: { icon: Film, labelKey: 'common:media.movie' },
  episode: { icon: Tv, labelKey: 'common:media.episode' },
  track: { icon: Music, labelKey: 'common:media.track' },
  live: { icon: Radio, labelKey: 'common:media.liveTV' },
  photo: { icon: Image, labelKey: 'common:media.photo' },
  trailer: { icon: Clapperboard, labelKey: 'pages:history.trailer' },
  unknown: { icon: CircleHelp, labelKey: 'common:labels.unknown' },
} as const satisfies Record<MediaType, { icon: typeof Film; labelKey: string }>;

// Format transcode reason codes into human-friendly labels
function formatReason(reason: string): string {
  return reason
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

function getWatchTime(session: SessionWithDetails | ActiveSession): number | null {
  if (session.durationMs) {
    return session.durationMs;
  }

  if (session.startedAt && !session.stoppedAt) {
    const elapsedMs = Date.now() - new Date(session.startedAt).getTime();
    return Math.max(0, elapsedMs - (session.pausedDurationMs ?? 0));
  }

  return null;
}

const LazyMiniMap = lazy(() =>
  import('@/components/map/MiniMap').then((m) => ({ default: m.MiniMap }))
);

// Memoized to prevent remounts while the sheet re-renders open
const MiniMap = memo(function MiniMap({ lat, lon }: { lat: number; lon: number }) {
  return (
    <Suspense fallback={<div className="bg-muted h-28 w-full animate-pulse rounded-lg" />}>
      <LazyMiniMap lat={lat} lon={lon} />
    </Suspense>
  );
});

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

function SegmentTable({
  segments,
  segmentCount,
}: {
  segments: SessionSegment[];
  segmentCount?: number;
}) {
  const { t } = useTranslation(['common', 'pages']);

  return (
    <div className="text-sm">
      <table className="w-full">
        <thead>
          <tr className="text-muted-foreground text-xs">
            <th className="pr-3 pb-1.5 text-left font-medium">#</th>
            <th className="pr-3 pb-1.5 text-left font-medium">{t('labels.started')}</th>
            <th className="pr-3 pb-1.5 text-left font-medium">{t('labels.stopped')}</th>
            <th className="pr-3 pb-1.5 text-right font-medium">
              {t('pages:history.detail.watch')}
            </th>
            <th className="pb-1.5 text-right font-medium">{t('playback.paused')}</th>
          </tr>
        </thead>
        <tbody>
          {segments.map((seg, i) => {
            const startDate = new Date(seg.startedAt);
            const stopDate = seg.stoppedAt ? new Date(seg.stoppedAt) : null;

            return (
              <tr key={i} className="border-border/50 border-t">
                <td className="text-muted-foreground py-1 pr-3">{i + 1}</td>
                <td className="py-1 pr-3">{formatDate(startDate, DATE_TIME_OPTIONS)}</td>
                <td className="py-1 pr-3">
                  {stopDate ? formatDate(stopDate, DATE_TIME_OPTIONS) : '-'}
                </td>
                <td className="py-1 pr-3 text-right">
                  {formatDuration(seg.durationMs, { style: 'compact' })}
                </td>
                <td className="py-1 text-right">
                  {seg.pausedDurationMs > 0
                    ? formatDuration(seg.pausedDurationMs, { style: 'compact' })
                    : '-'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {segmentCount && segmentCount > segments.length && (
        <p className="text-muted-foreground mt-1.5 text-xs">
          {t('pages:history.detail.segmentsShown', {
            shown: segments.length,
            count: segmentCount,
          })}
        </p>
      )}
    </div>
  );
}

// Inner content component - keeps state hooks and derived values together
function SessionContent({
  session,
  onNavigate,
}: {
  session: SessionWithDetails | ActiveSession;
  onNavigate: () => void;
}) {
  const { t } = useTranslation(['common', 'pages']);
  const viewer = useAuth().user;
  const canOpenUser = !!viewer && isStaff(viewer.role);
  const [locationOpen, setLocationOpen] = useState(false);
  const [segmentsOpen, setSegmentsOpen] = useState(false);

  // Reset segment view when session changes
  const sessionId = session.id;
  const [prevSessionId, setPrevSessionId] = useState(sessionId);
  if (sessionId !== prevSessionId) {
    setPrevSessionId(sessionId);
    setSegmentsOpen(false);
  }

  const stateConfig = STATE_CONFIG[session.state];
  const mediaConfig = MEDIA_CONFIG[session.mediaType];
  const MediaIcon = mediaConfig.icon;
  const { title: primary, subtitle: secondary } = getMediaDisplay(session);
  const mediaLinks = getMediaLinks(session);
  const progress = getSessionProgress(session);
  const geoCountryName = getCountryName(session.geoCountry);
  const geoCoordinates =
    session.geoLat !== null && session.geoLon !== null
      ? `${session.geoLat.toFixed(4)}, ${session.geoLon.toFixed(4)}`
      : null;
  const geoAsnNumber = session.geoAsnNumber ? `AS${session.geoAsnNumber}` : null;

  const posterUrl = session.thumbPath
    ? imageProxyUrl(
        session.serverId,
        session.thumbPath,
        POSTER_IMAGE_SIZE.width,
        POSTER_IMAGE_SIZE.height,
        'poster'
      )
    : null;

  const locationParts = [session.geoCity, session.geoRegion, geoCountryName].filter(Boolean);
  const locationString = locationParts.join(', ');
  const transcodeReasons = session.transcodeInfo?.reasons ?? [];
  const hasTranscodeReason = transcodeReasons.length > 0;
  const transcodeReasonText = transcodeReasons.map(formatReason).join(', ');

  return (
    <>
      <SheetHeader className="pb-4">
        <SheetTitle className="flex items-center gap-2 pr-8 text-base">
          <stateConfig.icon className={cn('h-4 w-4', stateConfig.color)} />
          {t('labels.sessionDetails')}
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
            {t(stateConfig.labelKey)}
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
              {t(mediaConfig.labelKey)}
              {session.year && <span>· {session.year}</span>}
            </div>
            <div className="flex items-center gap-1.5 leading-tight font-medium">
              <span className="truncate">
                <MediaPageLink to={mediaLinks.title} onNavigate={onNavigate}>
                  {primary}
                </MediaPageLink>
              </span>
              {session.watched && <Eye className="text-success h-3.5 w-3.5 flex-shrink-0" />}
            </div>
            {secondary && (
              <div className="text-muted-foreground mt-0.5 truncate text-sm">
                <MediaPageLink to={mediaLinks.subtitle} onNavigate={onNavigate}>
                  {secondary}
                </MediaPageLink>
              </div>
            )}
            {progress !== null && (
              <div className="mt-2 flex items-center gap-2">
                <Progress value={progress} className="h-1.5 flex-1" />
                <span className="text-muted-foreground w-8 text-xs">{progress}%</span>
              </div>
            )}
          </div>
        </div>

        {/* User: a member sees their own account without a page to open */}
        {(() => {
          const body = (
            <>
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
                {canOpenUser && (
                  <p className="text-muted-foreground text-xs">{t('actions.viewProfile')}</p>
                )}
              </div>
            </>
          );
          return canOpenUser ? (
            <Link
              to={`/users/${session.serverUserId}`}
              className="hover:bg-muted/50 flex items-center gap-3 rounded-lg border p-3 transition-colors"
            >
              {body}
              <ExternalLink className="text-muted-foreground h-4 w-4" />
            </Link>
          ) : (
            <div className="flex items-center gap-3 rounded-lg border p-3">{body}</div>
          );
        })()}

        {/* Server */}
        <Section icon={Server} title={t('labels.server')}>
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">{t('labels.server')}</span>
            <span className="flex items-center gap-1.5">
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: SERVER_TYPE_BRAND_COLORS[session.server.type] }}
              />
              <span>{SERVER_PROFILES[session.server.type].displayName}</span>
              <span className="text-muted-foreground">·</span>
              {session.server.name}
            </span>
          </div>
        </Section>

        {/* Playback Info */}
        <Section
          icon={Clock}
          title={t('labels.playback')}
          badge={
            'segmentCount' in session && session.segmentCount && session.segmentCount > 1 ? (
              <button
                type="button"
                onClick={() => setSegmentsOpen((prev) => !prev)}
                className="cursor-pointer focus-visible:outline-none"
              >
                <Badge variant="outline" className="gap-0.5 text-xs">
                  {segmentsOpen ? (
                    <>
                      <ChevronLeft className="h-3 w-3" />
                      {t('pages:history.detail.summary')}
                    </>
                  ) : (
                    <>
                      {t('count.segment', { count: session.segmentCount })}
                      <ChevronRight className="h-3 w-3" />
                    </>
                  )}
                </Badge>
              </button>
            ) : null
          }
        >
          {segmentsOpen && 'segments' in session && session.segments ? (
            <SegmentTable
              segments={session.segments}
              segmentCount={'segmentCount' in session ? session.segmentCount : undefined}
            />
          ) : (
            <div className="space-y-1.5 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('labels.started')}</span>
                <span>
                  {formatDate(new Date(session.startedAt), DATE_TIME_OPTIONS)}
                  <span className="text-muted-foreground ml-1.5 text-xs">
                    ({formatDistanceToNow(new Date(session.startedAt), { addSuffix: true })})
                  </span>
                </span>
              </div>
              {session.stoppedAt && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('labels.stopped')}</span>
                  <span>{formatDate(new Date(session.stoppedAt), DATE_TIME_OPTIONS)}</span>
                </div>
              )}
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">
                  {t(verbKeysFor(session.mediaType).watchTime)}
                </span>
                <span>{formatDuration(getWatchTime(session), { style: 'compact' })}</span>
              </div>
              {session.pausedDurationMs > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('playback.paused')}</span>
                  <span>{formatDuration(session.pausedDurationMs, { style: 'compact' })}</span>
                </div>
              )}
              {session.totalDurationMs && (
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('labels.mediaLength')}</span>
                  <span>{formatDuration(session.totalDurationMs, { style: 'compact' })}</span>
                </div>
              )}
            </div>
          )}
        </Section>

        {/* Location & Network */}
        <Section icon={MapPin} title={t('labels.location')}>
          <Collapsible open={locationOpen} onOpenChange={setLocationOpen} className="space-y-2">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="hover:text-foreground flex w-full items-center justify-between text-sm transition-colors"
              >
                <span className="text-muted-foreground">{t('labels.ipAddress')}</span>
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
            {session.geoLat !== null && session.geoLon !== null && (
              <MiniMap lat={session.geoLat} lon={session.geoLon} />
            )}
            {locationString && (
              <div className="flex items-center gap-1.5 text-sm">
                <Globe className="text-muted-foreground h-3.5 w-3.5 flex-shrink-0" />
                <span>{locationString}</span>
                <LocalBadge isLocal={session.isLocal} country={session.geoCountry} />
              </div>
            )}
            <CollapsibleContent className="space-y-2">
              <div className="space-y-1.5 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t('pages:history.location.continent')}
                  </span>
                  <span>{session.geoContinent ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t('pages:history.location.country')}
                  </span>
                  <span>{geoCountryName ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t('pages:history.location.region')}
                  </span>
                  <span>{session.geoRegion ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('pages:history.location.city')}</span>
                  <span>{session.geoCity ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t('pages:history.location.postalCode')}
                  </span>
                  <span>{session.geoPostal ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t('pages:history.location.coordinates')}
                  </span>
                  <span className="font-mono text-xs">{geoCoordinates ?? '—'}</span>
                </div>
                <Separator className="my-2" />
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">{t('pages:history.location.asn')}</span>
                  <span>{geoAsnNumber ?? '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted-foreground">
                    {t('pages:history.location.asnOrg')}
                  </span>
                  <span className="max-w-[180px] truncate text-right">
                    {session.geoAsnOrganization ?? '—'}
                  </span>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>
        </Section>

        {/* Device */}
        <Section icon={Smartphone} title={t('labels.device')}>
          <div className="space-y-1.5 text-sm">
            {session.platform && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('labels.platform')}</span>
                <span>{session.platform}</span>
              </div>
            )}
            {session.product && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('labels.product')}</span>
                <span>{session.product}</span>
              </div>
            )}
            {session.device && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('labels.device')}</span>
                <span>{session.device}</span>
              </div>
            )}
            {session.playerName && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('labels.player')}</span>
                <span>{session.playerName}</span>
              </div>
            )}
            {session.deviceId && (
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">{t('labels.deviceId')}</span>
                <span className="max-w-[160px] truncate font-mono text-xs">{session.deviceId}</span>
              </div>
            )}
          </div>
        </Section>

        {/* Stream Details */}
        <Section
          icon={Gauge}
          title={t('labels.streamDetails')}
          badge={(() => {
            const { decision, Icon, variant, isBurnIn } = playbackBadge(session);
            const content = (
              <>
                <Icon className="h-3 w-3" />
                {t(PLAYBACK_DECISION_LABEL_KEYS[decision])}
              </>
            );

            const decisionBadge = (
              <Badge variant={variant} className="gap-1 text-xs">
                {session.isTranscode && hasTranscodeReason ? (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="flex items-center gap-1">{content}</span>
                      </TooltipTrigger>
                      <TooltipContent side="top" className="max-w-xs text-left">
                        <span className="text-xs">{transcodeReasonText}</span>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                ) : (
                  content
                )}
              </Badge>
            );

            if (!isBurnIn) return decisionBadge;
            return (
              <span className="flex items-center gap-1">
                {decisionBadge}
                <Badge variant="warning" className="gap-1 text-xs">
                  <Subtitles className="h-3 w-3" />
                  {t('playback.burnIn')}
                </Badge>
              </span>
            );
          })()}
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
    </>
  );
}

export function SessionDetailSheet({ session, open, onOpenChange }: Props) {
  if (!session) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-[500px]">
        <SessionContent session={session} onNavigate={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}
