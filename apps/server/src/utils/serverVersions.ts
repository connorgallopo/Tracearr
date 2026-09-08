/**
 * Media-server versions: what a server reports about itself, what its vendor ships,
 * and which of the two is newer. Every feed is public and read without a token.
 */

import type { ServerType } from '@tracearr/shared';
import { fetchJson } from './http.js';
import { createLogger } from './logger.js';
import { compareVersions, maxVersion } from './pluginVersion.js';

const logger = createLogger('server-versions');

const PLEX_DOWNLOADS_URL = 'https://plex.tv/api/downloads/5.json';
const GITHUB_LATEST: Record<'jellyfin' | 'emby', string> = {
  jellyfin: 'https://api.github.com/repos/jellyfin/jellyfin/releases/latest',
  emby: 'https://api.github.com/repos/MediaBrowser/Emby.Releases/releases/latest',
};

/** Where a nudge sends the reader; the feeds carry per-release links, these outlive them. */
export const SERVER_RELEASE_PAGES: Record<ServerType, string> = {
  plex: 'https://plex.tv/media-server-downloads',
  jellyfin: 'https://github.com/jellyfin/jellyfin/releases/latest',
  emby: 'https://github.com/MediaBrowser/Emby.Releases/releases/latest',
};

const FEED_TIMEOUT_MS = 10_000;
// Two to four parts. `compareVersions` only reads three- and four-part versions, so a
// two-part release gets padded rather than dropped: Jellyfin tags 12.0 as `v12.0` while
// the server reports `12.0.0`, and the two have to compare equal.
const DOTTED = /^\d+(\.\d+){1,3}$/;

interface PlexDownloads {
  computer?: Record<string, { version?: unknown } | undefined>;
}

/**
 * The comparable digits of a version: Plex appends a build hash, Jellyfin tags with a
 * leading `v`, Emby is already numeric. A two-part version gains a `.0` so the
 * comparator can read it. Null when what is left is not two to four dotted numbers.
 */
export function normalizeServerVersion(type: ServerType, raw: string): string | null {
  const trimmed = raw.trim();
  let candidate = trimmed;
  if (type === 'plex') candidate = trimmed.split('-')[0] ?? '';
  if (type === 'jellyfin') candidate = trimmed.replace(/^v/, '');
  if (!DOTTED.test(candidate)) return null;
  return candidate.split('.').length === 2 ? `${candidate}.0` : candidate;
}

/** An unparseable version on either side is never newer: a nudge needs both numbers. */
export function isNewerServerVersion(type: ServerType, latest: string, installed: string): boolean {
  const newer = normalizeServerVersion(type, latest);
  const current = normalizeServerVersion(type, installed);
  if (!newer || !current) return false;
  return compareVersions(newer, current) > 0;
}

/** Plex publishes one version per platform; they move together, so the newest stands in. */
async function latestPlexVersion(): Promise<string | null> {
  const feed = await fetchJson<PlexDownloads>(PLEX_DOWNLOADS_URL, {
    timeout: FEED_TIMEOUT_MS,
    service: 'plex',
  });
  const versions = Object.values(feed.computer ?? {})
    .map((entry) =>
      typeof entry?.version === 'string' ? normalizeServerVersion('plex', entry.version) : null
    )
    .filter((version): version is string => version !== null);
  return maxVersion(versions);
}

async function latestGithubVersion(type: 'jellyfin' | 'emby'): Promise<string | null> {
  const release = await fetchJson<{ tag_name?: unknown }>(GITHUB_LATEST[type], {
    timeout: FEED_TIMEOUT_MS,
    service: 'github',
  });
  return typeof release.tag_name === 'string'
    ? normalizeServerVersion(type, release.tag_name)
    : null;
}

/** The newest release the vendor publishes, normalized. Any failure reads as "unknown". */
export async function latestVersionFor(type: ServerType): Promise<string | null> {
  try {
    return type === 'plex' ? await latestPlexVersion() : await latestGithubVersion(type);
  } catch (error) {
    // A firewalled or renamed feed is otherwise invisible: the nudge just never comes.
    logger.warn('Latest version lookup failed', { type, error });
    return null;
  }
}
