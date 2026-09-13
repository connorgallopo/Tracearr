import { tokenStorage } from '@/lib/api';

/**
 * Boot sweep of legacy localStorage auth tokens left behind by older builds.
 * Cookie sessions replaced these tokens.
 */
export function sweepLegacyTokens(): void {
  tokenStorage.clearTokens(true);
}
