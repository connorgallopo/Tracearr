/**
 * Resolution Normalizer
 *
 * Normalizes video resolution from various sources (Plex, Jellyfin, Emby)
 * into consistent, display-friendly labels for Tracearr.
 *
 * Thin wrapper around the shared classifier in @tracearr/shared/resolution -
 * kept so existing callers (session mapper, rules engine) don't need to
 * change their input shape.
 *
 * This utility is used by:
 * - Session mapper (for live sessions)
 * - Rules engine (for resolution-based conditions)
 */

import {
  normalizeResolution as normalizeResolutionShared,
  type ResolutionLabel,
} from '@tracearr/shared';

export interface ResolutionInput {
  /** Resolution string from API (e.g., "1080", "1080p", "4k", "sd") */
  resolution?: string;
  /** Video width in pixels */
  width?: number;
  /** Video height in pixels (used together with width to handle all aspect ratios) */
  height?: number;
}

/** Dimensions win; the server's label only fills in when a payload carries none. */
export function normalizeResolution(input: ResolutionInput): ResolutionLabel | null {
  const { resolution, width, height } = input;
  return normalizeResolutionShared({ label: resolution, width, height });
}

/**
 * Build quality display string from session quality data
 *
 * @param quality - Session quality object
 * @returns Quality string for display (e.g., "4K", "1080p", "54 Mbps", "Direct")
 */
export function formatQualityString(quality: {
  videoResolution?: string;
  videoWidth?: number;
  videoHeight?: number;
  bitrate?: number;
  isTranscode?: boolean;
  streamVideoDetails?: { width?: number; height?: number };
}): string {
  const effectiveWidth = quality.isTranscode
    ? (quality.streamVideoDetails?.width ?? quality.videoWidth)
    : quality.videoWidth;
  const effectiveHeight = quality.isTranscode
    ? (quality.streamVideoDetails?.height ?? quality.videoHeight)
    : quality.videoHeight;

  // Prefer resolution-based display
  const resolution = normalizeResolution({
    resolution: quality.videoResolution,
    width: effectiveWidth,
    height: effectiveHeight,
  });

  if (resolution) {
    return resolution;
  }

  // Fall back to bitrate if available
  if (quality.bitrate && quality.bitrate > 0) {
    const mbps = quality.bitrate / 1000;
    const formatted = mbps % 1 === 0 ? mbps.toFixed(0) : mbps.toFixed(1);
    return `${formatted} Mbps`;
  }

  // Last resort: transcode status
  return quality.isTranscode ? 'Transcoding' : 'Direct';
}
