/**
 * Shared utilities for user components
 */
import { trustLevel, type TrustLevel } from '@tracearr/shared';
import { imageProxyUrl } from '@/lib/api';

/**
 * Generate proxied avatar URL for user thumbnails
 */
export function getAvatarUrl(
  serverId: string | null | undefined,
  thumbUrl: string | null | undefined,
  size = 100
): string | null {
  if (!thumbUrl) return null;
  // If thumbUrl is already a full URL (e.g., from Plex.tv), use it directly
  if (thumbUrl.startsWith('http')) return thumbUrl;
  // Otherwise, proxy through our server
  if (!serverId) return null;
  return imageProxyUrl(serverId, thumbUrl, size, size, 'avatar');
}

const TRUST_LEVEL_TEXT_CLASSES: Record<TrustLevel, string> = {
  trusted: 'text-green-500',
  caution: 'text-yellow-500',
  untrusted: 'text-red-500',
};

const TRUST_LEVEL_BG_CLASSES: Record<TrustLevel, string> = {
  trusted: 'bg-green-500/20',
  caution: 'bg-yellow-500/20',
  untrusted: 'bg-red-500/20',
};

/**
 * Get text color class based on trust score
 */
export function getTrustScoreColor(score: number): string {
  return TRUST_LEVEL_TEXT_CLASSES[trustLevel(score)];
}

/**
 * Get background color class based on trust score
 */
export function getTrustScoreBg(score: number): string {
  return TRUST_LEVEL_BG_CLASSES[trustLevel(score)];
}

/**
 * Medal configuration for podium ranks
 */
export const MEDALS = {
  1: {
    emoji: '🥇',
    color: 'from-yellow-400 to-yellow-600',
    bgColor: 'from-yellow-500/10 to-yellow-600/5',
    size: 'h-20 w-20',
  },
  2: {
    emoji: '🥈',
    color: 'from-gray-300 to-gray-500',
    bgColor: 'from-gray-400/10 to-gray-500/5',
    size: 'h-16 w-16',
  },
  3: {
    emoji: '🥉',
    color: 'from-amber-600 to-amber-800',
    bgColor: 'from-amber-500/10 to-amber-600/5',
    size: 'h-16 w-16',
  },
} as const;
