import type { PluginIssue, JellyfinEmbyServerType } from '@tracearr/shared';
import { mediaBrowserTokenHeader } from './baseMediaServerClient.js';

/**
 * Asks the media server's own plugin list whether the Tracearr SSE plugin is
 * actually installed, so a 404 on the SSE endpoint can be reported as what it
 * is: plugin missing, installed-but-blocked (reverse proxy), pending a server
 * restart, or failed to load. Jellyfin reports a Status per plugin; Emby only
 * lists loaded plugins, so presence there means the endpoint should exist.
 */

// Plugin GUIDs from the Media-Server-SSE manifests. Jellyfin returns ids
// dashless, Emby dashed; compare normalized.
const SSE_PLUGIN_GUID = {
  jellyfin: 'b4a6d7e28f3c4a1e9d5b2c7f0e8a1b3d',
  emby: 'a3d8f1e62b7c4e9a8f5d1c6b0a3e7f92',
} as const;

const PLUGIN_LIST_PATH = {
  jellyfin: '/Plugins',
  emby: '/emby/Plugins',
} as const;

const PROBE_TIMEOUT_MS = 10_000;

interface PluginListEntry {
  Name?: string;
  Id?: string;
  Status?: string;
}

function normalizeGuid(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

export async function probeSsePlugin(config: {
  baseUrl: string;
  serverType: JellyfinEmbyServerType;
  token: string;
}): Promise<PluginIssue> {
  const { baseUrl, serverType, token } = config;
  const url = `${baseUrl.replace(/\/$/, '')}${PLUGIN_LIST_PATH[serverType]}`;

  try {
    const response = await fetch(url, {
      headers: mediaBrowserTokenHeader(serverType, token),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return 'unknown';

    const plugins = await response.json();
    if (!Array.isArray(plugins)) return 'unknown';

    const wanted = SSE_PLUGIN_GUID[serverType];
    const entry = plugins.find(
      (p: PluginListEntry) =>
        (typeof p.Id === 'string' && normalizeGuid(p.Id) === wanted) || p.Name === 'Tracearr SSE'
    ) as PluginListEntry | undefined;
    if (!entry) return 'missing';

    if (serverType === 'jellyfin') {
      // Jellyfin PluginStatus: Active, Restart (pending restart), Malfunctioned,
      // NotSupported, Disabled, Deleted, Superceded
      if (entry.Status === 'Restart') return 'restart_required';
      if (entry.Status !== undefined && entry.Status !== 'Active') return 'malfunctioned';
    }

    return 'blocked';
  } catch {
    return 'unknown';
  }
}
