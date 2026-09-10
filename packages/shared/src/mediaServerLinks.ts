/**
 * Deep links to a single item in a media server's own web client. Formats
 * verified against Plex 1.43.3, Emby 4.9.5.0 and Jellyfin 12.0.0, which agree
 * on nothing: Plex routes through app.plex.tv (a LAN URL is useless to remote
 * users) and needs machineIdentifier, Emby needs `#!` and a serverId or the
 * page 404s, Jellyfin needs a bare `#` and the item id alone.
 *
 * Null means a required identifier is missing; link to the server root.
 */

import type { ServerType } from './types.js';

export interface MediaServerItemLinkInput {
  serverType: ServerType;
  /** Server URL as configured in Tracearr. Ignored for Plex. */
  baseUrl: string;
  /** Item id on that server: Plex ratingKey, Emby/Jellyfin item id. */
  ratingKey: string;
  /** The media server's own id, not Tracearr's server row id. */
  machineIdentifier?: string | null;
}

const PLEX_APP_BASE = 'https://app.plex.tv/desktop';

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

export function buildMediaServerItemUrl({
  serverType,
  baseUrl,
  ratingKey,
  machineIdentifier,
}: MediaServerItemLinkInput): string | null {
  if (!ratingKey) return null;

  switch (serverType) {
    case 'plex': {
      if (!machineIdentifier) return null;
      const key = encodeURIComponent(`/library/metadata/${ratingKey}`);
      return `${PLEX_APP_BASE}/#!/server/${encodeURIComponent(machineIdentifier)}/details?key=${key}`;
    }
    case 'emby': {
      if (!machineIdentifier) return null;
      const root = trimTrailingSlash(baseUrl);
      if (!root) return null;
      return `${root}/web/index.html#!/item?id=${encodeURIComponent(ratingKey)}&serverId=${encodeURIComponent(machineIdentifier)}`;
    }
    case 'jellyfin': {
      const root = trimTrailingSlash(baseUrl);
      if (!root) return null;
      return `${root}/web/index.html#/details?id=${encodeURIComponent(ratingKey)}`;
    }
    default:
      return null;
  }
}

const PRIVATE_SUFFIXES = ['.local', '.ts.net'];

function privateIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return false;
  }
  const [a, b] = parts as [number, number, number, number];
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function privateIpv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h.startsWith('::ffff:')) return privateIpv4(h.slice(7));
  return (
    h === '::1' ||
    h === '::' ||
    h.startsWith('fc') ||
    h.startsWith('fd') ||
    h.startsWith('fe8') ||
    h.startsWith('fe9') ||
    h.startsWith('fea') ||
    h.startsWith('feb')
  );
}

/**
 * Whether a member off the LAN could open this URL: false for loopback, RFC 1918,
 * link-local, CGNAT (Tailscale's 100.64.0.0/10), `.local`, `.ts.net` and any host
 * without a dot; true otherwise. A URL that does not parse counts as private.
 */
export function isPubliclyRoutableUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host.startsWith('[') && host.endsWith(']')) return !privateIpv6(host.slice(1, -1));
  if (host.includes(':')) return !privateIpv6(host);
  if (!host.includes('.')) return false;
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  return !privateIpv4(host);
}

/**
 * The address a member off the LAN opens the server at: the admin's public address when set,
 * else the configured URL when that is public itself. Null means no member-facing link exists;
 * a private public address is not rescued by a public URL, since the admin said members use it.
 */
export function memberFacingUrl(server: { url: string; publicUrl?: string | null }): string | null {
  const candidate = server.publicUrl ?? server.url;
  return isPubliclyRoutableUrl(candidate) ? candidate : null;
}
