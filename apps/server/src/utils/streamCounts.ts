import { type PlaybackDecisionInput, playbackDecision } from '@tracearr/shared';

export interface StreamCounts {
  total: number;
  /** Every transcode, audio-only ones included. */
  transcodes: number;
  /** The audio-only part of `transcodes`. */
  audioTranscodes: number;
  directStreams: number;
  directPlays: number;
  bitrateKbps: number;
}

interface CountableStream extends PlaybackDecisionInput {
  serverId: string;
  server: { name: string };
  bitrate?: number | null;
}

const emptyCounts = (): StreamCounts => ({
  total: 0,
  transcodes: 0,
  audioTranscodes: 0,
  directStreams: 0,
  directPlays: 0,
  bitrateKbps: 0,
});

function add(counts: StreamCounts, stream: CountableStream): void {
  const decision = playbackDecision(stream);
  counts.total++;
  if (decision === 'transcode') counts.transcodes++;
  else if (decision === 'audio_transcode') {
    counts.transcodes++;
    counts.audioTranscodes++;
  } else if (decision === 'copy') counts.directStreams++;
  else counts.directPlays++;
  if (stream.bitrate) counts.bitrateKbps += stream.bitrate;
}

export function countStreams(streams: readonly CountableStream[]): {
  overall: StreamCounts;
  byServer: (StreamCounts & { serverId: string; serverName: string })[];
} {
  const overall = emptyCounts();
  const byServer = new Map<string, StreamCounts & { serverId: string; serverName: string }>();

  for (const stream of streams) {
    add(overall, stream);
    add(
      byServer.getOrInsertComputed(stream.serverId, (serverId) => ({
        serverId,
        serverName: stream.server.name,
        ...emptyCounts(),
      })),
      stream
    );
  }

  return { overall, byServer: [...byServer.values()] };
}
