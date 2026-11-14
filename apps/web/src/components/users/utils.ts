/**
 * Shared utilities for user components
 */
import {
  isDirectAvatarUrl,
  isProxiableAvatarUrl,
  type ServerUserWithIdentity,
} from '@tracearr/shared';
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
  if (thumbUrl.startsWith('http') && !isProxiableAvatarUrl(thumbUrl)) {
    return isDirectAvatarUrl(thumbUrl) ? thumbUrl : null;
  }
  // Otherwise, proxy through our server
  if (!serverId) return null;
  return imageProxyUrl(serverId, thumbUrl, size, size, 'avatar');
}

/** A roster row's person name. Only the list endpoint sends personName, so other rows fall back. */
export function rosterPersonName(
  row: Pick<ServerUserWithIdentity, 'personName' | 'identityName' | 'username'>
): string {
  return row.personName ?? row.identityName ?? row.username;
}
