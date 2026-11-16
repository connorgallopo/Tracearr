import {
  formatEpisodeLabel,
  namesShow,
  type PlaybackDecision,
  playbackDecision,
} from '@tracearr/shared';
import type { ActiveSession } from '../types.js';

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return `${minutes}m ${remainingSeconds}s`;
  }
  return `${seconds}s`;
}

/** Get display title for media (matches UI card logic) */
export function getMediaDisplay(session: ActiveSession): {
  title: string;
  subtitle: string | null;
} {
  if (namesShow(session)) {
    const episodeInfo =
      formatEpisodeLabel(session.seasonNumber, session.episodeNumber, { spaced: true }) ?? '';
    return {
      title: session.grandparentTitle,
      subtitle: episodeInfo ? `${episodeInfo} · ${session.mediaTitle}` : session.mediaTitle,
    };
  }
  return {
    title: session.mediaTitle,
    subtitle: session.year ? `${session.year}` : null,
  };
}

const PLAYBACK_TYPE_LABELS: Record<PlaybackDecision, string> = {
  directplay: 'Direct Play',
  copy: 'Direct Stream',
  audio_transcode: 'Audio Transcode',
  transcode: 'Transcode',
};

export function getPlaybackType(session: ActiveSession): string {
  return PLAYBACK_TYPE_LABELS[playbackDecision(session)];
}

export function getUserDisplayName(session: ActiveSession): string {
  return session.user.identityName ?? session.user.username;
}
