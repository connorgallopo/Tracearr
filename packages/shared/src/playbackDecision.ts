export type PlaybackDecision = 'directplay' | 'copy' | 'transcode';

/** Keys in the `common` translation namespace, without the namespace prefix. */
export const PLAYBACK_DECISION_LABEL_KEYS = {
  directplay: 'playback.directPlay',
  copy: 'playback.directStream',
  transcode: 'playback.transcode',
} as const satisfies Record<PlaybackDecision, string>;

export interface PlaybackDecisionInput {
  isTranscode?: boolean | null;
  videoDecision?: string | null;
  audioDecision?: string | null;
}

/** Any copied stream makes the whole session a Direct Stream. */
export function playbackDecision(session: PlaybackDecisionInput): PlaybackDecision {
  if (session.isTranscode) return 'transcode';
  return session.videoDecision === 'copy' || session.audioDecision === 'copy'
    ? 'copy'
    : 'directplay';
}
