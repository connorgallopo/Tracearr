/**
 * Stream Details Panel - displays source vs stream codec information
 */

import { ArrowRight, Video, AudioLines, Subtitles, Cpu, ChevronDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import type {
  SourceVideoDetails,
  SourceAudioDetails,
  StreamVideoDetails,
  StreamAudioDetails,
  TranscodeInfo,
  SubtitleInfo,
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
}

// Format bitrate for display
function formatBitrate(bitrate: number | null | undefined): string {
  if (!bitrate) return '—';
  if (bitrate >= 1000) return `${(bitrate / 1000).toFixed(1)} Mbps`;
  return `${bitrate} kbps`;
}

// Format resolution
function formatResolution(
  width: number | null | undefined,
  height: number | null | undefined
): string {
  if (!width || !height) return '—';
  // Common resolution labels
  if (height >= 2160) return `${width}×${height} (4K)`;
  if (height >= 1080) return `${width}×${height} (1080p)`;
  if (height >= 720) return `${width}×${height} (720p)`;
  if (height >= 480) return `${width}×${height} (480p)`;
  return `${width}×${height}`;
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

// Comparison row component
function ComparisonRow({
  label,
  sourceValue,
  streamValue,
  showArrow = true,
}: {
  label: string;
  sourceValue: string;
  streamValue?: string;
  showArrow?: boolean;
}) {
  const isDifferent =
    streamValue && sourceValue !== streamValue && sourceValue !== '—' && streamValue !== '—';

  return (
    <div className="grid grid-cols-[100px_1fr_24px_1fr] items-center gap-2 py-1 text-sm">
      <span className="text-muted-foreground truncate">{label}</span>
      <span className="truncate font-medium">{sourceValue}</span>
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
      {streamValue !== undefined ? (
        <span className={cn('truncate', isDifferent && 'font-medium text-amber-500')}>
          {streamValue}
        </span>
      ) : null}
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

  return (
    <div className="space-y-3">
      {/* Column headers */}
      <div className="text-muted-foreground grid grid-cols-[100px_1fr_24px_1fr] items-center gap-2 text-xs">
        <span />
        <span className="font-medium tracking-wide uppercase">Source</span>
        <span />
        <span className="font-medium tracking-wide uppercase">Stream</span>
      </div>

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
              streamValue={formatBitrate(
                streamVideoDetails?.bitrate ?? sourceVideoDetails?.bitrate
              )}
            />
            {/* Extended video details - only show if we have them */}
            {sourceVideoDetails?.framerate && (
              <ComparisonRow
                label="Framerate"
                sourceValue={sourceVideoDetails.framerate}
                streamValue={streamVideoDetails?.framerate ?? sourceVideoDetails.framerate}
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
          </div>
        </div>
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
              streamValue={formatBitrate(
                streamAudioDetails?.bitrate ?? sourceAudioDetails?.bitrate
              )}
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
      {bitrate && (
        <div className="flex justify-between border-t pt-1 text-sm">
          <span className="text-muted-foreground">Total Bitrate</span>
          <span className="font-medium">{formatBitrate(bitrate)}</span>
        </div>
      )}
    </div>
  );
}
