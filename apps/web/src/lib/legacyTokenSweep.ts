import { tokenStorage } from '@/lib/api';

/**
 * One-time boot sweep of legacy localStorage auth tokens. Cookie sessions
 * replaced these tokens; until the remaining writer (Connections.tsx, for
 * the Jellyfin/Emby API-key connect flow) is removed in a follow-up task, a
 * token written during a session can still exist until the next boot -
 * that's expected during the transition.
 */
export function sweepLegacyTokens(): void {
  tokenStorage.clearTokens(true);
}
