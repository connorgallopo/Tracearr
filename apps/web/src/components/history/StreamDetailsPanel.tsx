/**
 * Stream Details Panel - displays source vs stream codec information
 */

import { ArrowRight, Video, AudioLines, Subtitles, Cpu, ChevronDown, Info } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  formatBitrate,
  type SourceVideoDetails,
  type SourceAudioDetails,
  type StreamVideoDetails,
  type StreamAudioDetails,
  type TranscodeInfo,
  type SubtitleInfo,
  type ServerType,
} from '@tracearr/shared';
import { useState } from 'react';

interface StreamDetailsPanelProps {
  // Scalar codec fields
  sourceVideoCodec: string | null;
  sourceAudioCodec: string | null;
  sourceAudioChannels: number | null;
  sourceVideoWidth: number | null;
  sourceVideoHeight: number | null;
  streamVideoCodec: string | null;
  streamAudioCodec: string | null;
  // JSONB detail objects
  sourceVideoDetails: SourceVideoDetails | null;
  sourceAudioDetails: SourceAudioDetails | null;
  streamVideoDetails: StreamVideoDetails | null;
  streamAudioDetails: StreamAudioDetails | null;
  transcodeInfo: TranscodeInfo | null;
  subtitleInfo: SubtitleInfo | null;
  // Decisions
  videoDecision: string | null;
  audioDecision: string | null;
  bitrate: number | null;
  // Server type for conditional tooltip
  serverType: ServerType;
}

// Component for showing "N/A" with tooltip when stream bitrate is unavailable (Jellyfin/Emby only)
function UnavailableBitrate() {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="text-muted-foreground inline-flex cursor-help items-center gap-1">
          N/A
          <Info className="h-3 w-3" />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[250px]">
        <p className="text-xs">
          Jellyfin and Emby do not expose individual video/audio bitrates during transcoding—only
          the total stream bitrate is available.
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

// Format resolution using width-first logic to correctly classify
// widescreen/cinemascope content (e.g., 1920x800 = 1080p, not 720p)
function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined
): string {
  if (!width && !height) return '—';

  // Determine label using width-first logic (industry standard)
  let label: string | undefined;
  if (width) {
    if (width >= 3840) label = '4K';
    else if (width >= 1920) label = '1080p';
    else if (width >= 1280) label = '720p';
    else if (width >= 854) label = '480p';
    else label = 'SD';
  } else if (height) {
    // Fallback to height when width unavailable
    if (height >= 2160) label = '4K';
    else if (height >= 1080) label = '1080p';
    else if (height >= 720) label = '720p';
    else if (height >= 480) label = '480p';
    else label = 'SD';
  }

  // Format with dimensions if available
  if (width && height) return `${width}×${height} (${label})`;
  if (width) return `${width}w (${label})`;
  if (height) return `${height}p (${label})`;
  return '—';
}

// Format channels (e.g., 8 -> "7.1", 6 -> "5.1", 2 -> "Stereo")
function formatChannels(channels: number | null | undefined): string {
  if (!channels) return '—';
  if (channels === 8) return '7.1';
  if (channels === 6) return '5.1';
  if (channels === 2) return 'Stereo';
  if (channels === 1) return 'Mono';
  return `${channels}ch`;
}

function formatFramerate(framerate: string | number | null | undefined): string {
  if (framerate === null || framerate === undefined || framerate === '') return '—';
  const numeric = typeof framerate === 'number' ? framerate : parseFloat(String(framerate));
  if (Number.isNaN(numeric)) return String(framerate);
  return numeric % 1 === 0 ? numeric.toFixed(0) : numeric.toFixed(1);
}

// Get decision badge variant and label
function getDecisionBadge(decision: string | null): {
  variant: 'success' | 'warning' | 'secondary';
  label: string;
} {
  switch (decision) {
    case 'directplay':
      return { variant: 'success', label: 'Direct Play' };
    case 'copy':
      return { variant: 'success', label: 'Direct Stream' };
    case 'transcode':
      return { variant: 'warning', label: 'Transcode' };
    case 'burn':
      return { variant: 'warning', label: 'Burn-in' };
    default:
      return { variant: 'secondary', label: '—' };
  }
}

// Format codec name for display (uppercase common codecs)
function formatCodec(codec: string | null | undefined): string {
  if (!codec) return '—';
  const upper = codec.toUpperCase();
  // Keep common codecs uppercase
  if (
    [
      'H264',
      'H265',
      'HEVC',
      'AV1',
      'VP9',
      'AAC',
      'AC3',
      'EAC3',
      'DTS',
      'TRUEHD',
      'FLAC',
      'OPUS',
    ].includes(upper)
  ) {
    return upper;
  }
  // Title case for others
  return codec.charAt(0).toUpperCase() + codec.slice(1);
}

function formatTranscodeReason(reason: string): string {
  return reason
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .trim();
}

function filterTranscodeReasons(reasons: string[] | null | undefined, keyword: string): string[] {
  if (!reasons || reasons.length === 0) return [];
  const needle = keyword.toLowerCase();
  return reasons
    .filter((reason) => reason.toLowerCase().includes(needle))
    .map(formatTranscodeReason);
}

// Comparison row component
function ComparisonRow({
  label,
  sourceValue,
  streamValue,
  showArrow = true,
  sourceClassName,
  streamClassName,
  labelClassName,
  labelNoTruncate,
}: {
  label: string;
  sourceValue: string;
  streamValue?: React.ReactNode;
  showArrow?: boolean;
  sourceClassName?: string;
  streamClassName?: string;
  labelClassName?: string;
  labelNoTruncate?: boolean;
}) {
  // Only compare for highlighting when both values are strings
  const isDifferent =
    typeof streamValue === 'string' &&
    streamValue !== sourceValue &&
    sourceValue !== '—' &&
    streamValue !== '—';
  const sourceClasses = cn(sourceClassName ?? 'truncate font-medium');
  const streamClasses = cn(
    streamClassName ?? 'truncate',
    isDifferent && 'font-medium text-amber-500'
  );
  const labelClasses = cn(
    'text-muted-foreground',
    labelNoTruncate ? 'break-words whitespace-normal' : 'truncate',
    labelClassName
  );

  return (
    <div className="grid grid-cols-[100px_1fr_24px_1fr] items-center gap-2 py-1 text-sm">
      <span className={labelClasses}>{label}</span>
      <span className={sourceClasses}>{sourceValue}</span>
      {showArrow && streamValue !== undefined ? (
        <ArrowRight
          className={cn(
            'mx-auto h-3.5 w-3.5',
            isDifferent ? 'text-amber-500' : 'text-muted-foreground/50'
          )}
        />
      ) : (
        <span />
      )}
      {streamValue !== undefined ? <span className={streamClasses}>{streamValue}</span> : null}
    </div>
  );
}

// Section header
function SectionHeader({
  icon: Icon,
  title,
  badge,
}: {
  icon: typeof Video;
  title: string;
  badge?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-2">
      <div className="flex items-center gap-2 text-sm font-medium">
        <Icon className="text-muted-foreground h-4 w-4" />
        {title}
      </div>
      {badge}
    </div>
  );
}

function SectionColumnLabels({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        'text-muted-foreground grid grid-cols-[100px_1fr_24px_1fr] items-center gap-2 text-[10px] tracking-[0.3em] uppercase',
        className
      )}
    >
      <span />
      <span className="font-medium tracking-wide uppercase">Source</span>
      <span className="text-right font-medium tracking-wide uppercase">Stream</span>
    </div>
  );
}

export function StreamDetailsPanel({
  sourceVideoCodec,
  sourceAudioCodec,
  sourceAudioChannels,
  sourceVideoWidth,
  sourceVideoHeight,
  streamVideoCodec,
  streamAudioCodec,
  sourceVideoDetails,
  sourceAudioDetails,
  streamVideoDetails,
  streamAudioDetails,
  transcodeInfo,
  subtitleInfo,
  videoDecision,
  audioDecision,
  bitrate,
  serverType,
}: StreamDetailsPanelProps) {
  const [transcodeOpen, setTranscodeOpen] = useState(false);

  // Check if we have any stream details to show
  const hasVideoDetails = sourceVideoCodec || streamVideoCodec || sourceVideoWidth;
  const hasAudioDetails = sourceAudioCodec || streamAudioCodec || sourceAudioChannels;
  const hasSubtitleDetails = subtitleInfo?.codec || subtitleInfo?.language;
  const hasTranscodeDetails =
    transcodeInfo && (transcodeInfo.hwDecoding || transcodeInfo.hwEncoding || transcodeInfo.speed);

  // If no details at all, show a simple message
  if (!hasVideoDetails && !hasAudioDetails) {
    return (
      <div className="text-muted-foreground py-2 text-sm">
        No detailed stream information available
      </div>
    );
  }

  const videoBadge = getDecisionBadge(videoDecision);
  const audioBadge = getDecisionBadge(audioDecision);
  const transcodeReasons = transcodeInfo?.reasons ?? [];
  const videoTranscodeReasons = filterTranscodeReasons(transcodeReasons, 'video');
  const audioTranscodeReasons = filterTranscodeReasons(transcodeReasons, 'audio');

  return (
    <div className="space-y-3">
      {/* Container info */}
      {transcodeInfo?.sourceContainer && (
        <>
          <ComparisonRow
            label="Container"
            sourceValue={transcodeInfo.sourceContainer.toUpperCase()}
            streamValue={
              transcodeInfo.streamContainer?.toUpperCase() ??
              transcodeInfo.sourceContainer.toUpperCase()
            }
          />
          <Separator />
        </>
      )}

      {/* Video Section */}
      {hasVideoDetails && (
        <>
          <Separator className="border-border/50" />
          <div>
            <SectionHeader
              icon={Video}
              title="Video"
              badge={
                <Badge variant={videoBadge.variant} className="text-xs">
                  {videoBadge.label}
                </Badge>
              }
            />
            <div className="space-y-0.5 rounded-md border p-2">
              <SectionColumnLabels className="border-border/50 mb-1 border-b pb-1" />
              <ComparisonRow
                label="Codec"
                sourceValue={formatCodec(sourceVideoCodec)}
                streamValue={formatCodec(streamVideoCodec ?? sourceVideoCodec)}
              />

              <ComparisonRow
                label="Resolution"
                sourceValue={formatResolution(sourceVideoWidth, sourceVideoHeight)}
                streamValue={formatResolution(
                  streamVideoDetails?.width ?? sourceVideoWidth,
                  streamVideoDetails?.height ?? sourceVideoHeight
                )}
              />
              <ComparisonRow
                label="Bitrate"
                sourceValue={formatBitrate(sourceVideoDetails?.bitrate)}
                streamValue={
                  // Show N/A with tooltip for Jellyfin/Emby transcodes without stream bitrate
                  videoDecision === 'transcode' &&
                  !streamVideoDetails?.bitrate &&
                  serverType !== 'plex' ? (
                    <UnavailableBitrate />
                  ) : (
                    formatBitrate(streamVideoDetails?.bitrate ?? sourceVideoDetails?.bitrate)
                  )
                }
              />
              {/* Extended video details - only show if we have them */}
              {sourceVideoDetails?.framerate && (
                <ComparisonRow
                  label="Framerate"
                  sourceValue={formatFramerate(sourceVideoDetails.framerate)}
                  streamValue={formatFramerate(
                    streamVideoDetails?.framerate ?? sourceVideoDetails.framerate
                  )}
                />
              )}
              {sourceVideoDetails?.dynamicRange && (
                <ComparisonRow
                  label="HDR"
                  sourceValue={sourceVideoDetails.dynamicRange}
                  streamValue={streamVideoDetails?.dynamicRange ?? sourceVideoDetails.dynamicRange}
                />
              )}
              {sourceVideoDetails?.profile && (
                <ComparisonRow
                  label="Profile"
                  sourceValue={sourceVideoDetails.profile}
                  showArrow={false}
                />
              )}
              {sourceVideoDetails?.colorSpace && (
                <ComparisonRow
                  label="Color"
                  sourceValue={`${sourceVideoDetails.colorSpace}${sourceVideoDetails.colorDepth ? ` ${sourceVideoDetails.colorDepth}bit` : ''}`}
                  showArrow={false}
                />
              )}
              {videoDecision == 'transcode' && videoTranscodeReasons.length > 0 && (
                <ComparisonRow
                  label="Transcode Reason"
                  sourceValue={videoTranscodeReasons.join(', ')}
                  showArrow={false}
                  sourceClassName="break-words"
                  labelNoTruncate
                />
              )}
            </div>
          </div>
        </>
      )}

      {/* Audio Section */}
      {hasAudioDetails && (
        <div>
          <SectionHeader
            icon={AudioLines}
            title="Audio"
            badge={
              <Badge variant={audioBadge.variant} className="text-xs">
                {audioBadge.label}
              </Badge>
            }
          />
          <div className="space-y-0.5 rounded-md border p-2">
            <SectionColumnLabels className="border-border/50 mb-1 border-b pb-1" />
            <ComparisonRow
              label="Codec"
              sourceValue={formatCodec(sourceAudioCodec)}
              streamValue={formatCodec(streamAudioCodec ?? sourceAudioCodec)}
            />
            <ComparisonRow
              label="Channels"
              sourceValue={formatChannels(sourceAudioChannels)}
              streamValue={formatChannels(streamAudioDetails?.channels ?? sourceAudioChannels)}
            />
            <ComparisonRow
              label="Bitrate"
              sourceValue={formatBitrate(sourceAudioDetails?.bitrate)}
              streamValue={
                // Show N/A with tooltip for Jellyfin/Emby transcodes without stream bitrate
                audioDecision === 'transcode' &&
                !streamAudioDetails?.bitrate &&
                serverType !== 'plex' ? (
                  <UnavailableBitrate />
                ) : (
                  formatBitrate(streamAudioDetails?.bitrate ?? sourceAudioDetails?.bitrate)
                )
              }
            />
            {sourceAudioDetails?.language && (
              <ComparisonRow
                label="Language"
                sourceValue={sourceAudioDetails.language}
                streamValue={streamAudioDetails?.language ?? sourceAudioDetails.language}
              />
            )}
            {sourceAudioDetails?.sampleRate && (
              <ComparisonRow
                label="Sample Rate"
                sourceValue={`${sourceAudioDetails.sampleRate / 1000} kHz`}
                showArrow={false}
              />
            )}
            {audioDecision == 'transcode' && audioTranscodeReasons.length > 0 && (
              <ComparisonRow
                label="Transcode Reason"
                sourceValue={audioTranscodeReasons.join(', ')}
                showArrow={false}
                sourceClassName="break-words"
                labelNoTruncate
              />
            )}
          </div>
        </div>
      )}

      {/* Subtitles Section */}
      {hasSubtitleDetails && (
        <div>
          <SectionHeader
            icon={Subtitles}
            title="Subtitles"
            badge={
              subtitleInfo?.decision ? (
                <Badge
                  variant={getDecisionBadge(subtitleInfo.decision).variant}
                  className="text-xs"
                >
                  {getDecisionBadge(subtitleInfo.decision).label}
                </Badge>
              ) : undefined
            }
          />
          <div className="space-y-0.5 rounded-md border p-2">
            <div className="flex items-center gap-2 text-sm">
              <span className="text-muted-foreground">Format:</span>
              <span>{formatCodec(subtitleInfo?.codec)}</span>
              {subtitleInfo?.language && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span>{subtitleInfo.language}</span>
                </>
              )}
              {subtitleInfo?.forced && (
                <Badge variant="outline" className="text-xs">
                  Forced
                </Badge>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Transcode Details (collapsible) */}
      {hasTranscodeDetails && (
        <Collapsible open={transcodeOpen} onOpenChange={setTranscodeOpen}>
          <CollapsibleTrigger className="hover:text-foreground text-muted-foreground flex w-full items-center justify-between py-2 text-sm font-medium transition-colors">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4" />
              Transcode Details
            </div>
            <ChevronDown
              className={cn('h-4 w-4 transition-transform', transcodeOpen && 'rotate-180')}
            />
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-1.5 rounded-md border p-2 text-sm">
              {transcodeInfo?.hwDecoding && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">HW Decode</span>
                  <span>{transcodeInfo.hwDecoding}</span>
                </div>
              )}
              {transcodeInfo?.hwEncoding && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">HW Encode</span>
                  <span>{transcodeInfo.hwEncoding}</span>
                </div>
              )}
              {transcodeInfo?.speed !== undefined && (
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Speed</span>
                  <span className={cn(transcodeInfo.speed < 1 && 'text-amber-500')}>
                    {transcodeInfo.speed.toFixed(1)}x{transcodeInfo.throttled && ' (throttled)'}
                  </span>
                </div>
              )}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      {/* Overall bitrate */}
      {!!bitrate && (
        <div className="flex justify-between border-t pt-1 text-sm">
          <span className="text-muted-foreground">Total Bitrate</span>
          <span className="font-medium">{formatBitrate(bitrate)}</span>
        </div>
      )}
    </div>
  );
}
