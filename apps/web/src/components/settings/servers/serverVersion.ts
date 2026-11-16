import type { Server } from '@tracearr/shared';

/** Both columns hold three or four dotted numbers; a missing part reads as zero. */
function isNewer(latest: string, installed: string): boolean {
  const a = latest.split('.').map(Number);
  const b = installed.split('.').map(Number);
  for (let i = 0; i < 4; i++) {
    const na = a[i] ?? 0;
    const nb = b[i] ?? 0;
    if (na !== nb) return na > nb;
  }
  return false;
}

/**
 * The release a server could move to, or null. A server ahead of the vendor's public feed,
 * such as a Plex Pass build, counts as up to date, and so does one that has never answered
 * the update checker.
 */
export function availableUpdate(server: Server): string | null {
  if (!server.version || !server.latestVersion) return null;
  return isNewer(server.latestVersion, server.version) ? server.latestVersion : null;
}
