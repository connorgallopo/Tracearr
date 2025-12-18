/**
 * Shared utilities for user components
 */

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
  return `/api/v1/images/proxy?server=${serverId}&url=${encodeURIComponent(thumbUrl)}&width=${size}&height=${size}&fallback=avatar`;
}

/**
 * Get text color class based on trust score
 */
export function getTrustScoreColor(score: number): string {
  if (score >= 80) return 'text-green-500';
  if (score >= 50) return 'text-yellow-500';
  return 'text-red-500';
}

/**
 * Get background color class based on trust score
 */
export function getTrustScoreBg(score: number): string {
  if (score >= 80) return 'bg-green-500/20';
  if (score >= 50) return 'bg-yellow-500/20';
  return 'bg-red-500/20';
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
