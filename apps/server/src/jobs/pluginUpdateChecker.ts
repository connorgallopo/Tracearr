import { fetchJson } from '../utils/http.js';
import { startPeriodic, type PeriodicTimers } from '../utils/periodic.js';
import { maxVersion, compareVersions } from '../utils/pluginVersion.js';
import { sseManager } from '../services/sseManager.js';
import { getSettings } from '../services/settings.js';
import { liveServers } from '../services/liveServers.js';
import { isJellyfinEmby } from '../services/mediaServer/index.js';
import { dispatchPluginUpdate } from '../services/automations/events/producers.js';

const DEFAULT_MANIFEST_URL =
  'https://raw.githubusercontent.com/Tracearr/Media-Server-SSE/main/manifest.json';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;
const RELEASES_URL = 'https://github.com/Tracearr/Media-Server-SSE/releases/latest';

interface ManifestEntry {
  versions?: { version?: string }[];
}

let timers: PeriodicTimers | null = null;
// serverId -> latest version already nudged for; re-arms when latest changes
const nudgedVersions = new Map<string, string>();

export function _resetNudgeStateForTests(): void {
  nudgedVersions.clear();
}

export async function runPluginUpdateCheck(): Promise<void> {
  try {
    const settings = await getSettings(['pluginUpdateCheckEnabled', 'pluginManifestUrl']);
    if (!settings.pluginUpdateCheckEnabled) return;

    const url = settings.pluginManifestUrl ?? DEFAULT_MANIFEST_URL;
    let manifest: ManifestEntry[];
    try {
      manifest = await fetchJson<ManifestEntry[]>(url, { timeout: 10_000, service: 'github' });
    } catch (error) {
      console.warn('[PluginUpdate] Manifest fetch failed, skipping check:', error);
      return;
    }

    const allVersions = (Array.isArray(manifest) ? manifest : [])
      .flatMap((entry) => entry.versions ?? [])
      .map((v) => v.version)
      .filter((v): v is string => typeof v === 'string');
    const latest = maxVersion(allVersions);
    if (!latest) {
      console.warn('[PluginUpdate] No parseable versions in manifest, skipping check');
      return;
    }

    sseManager.setLatestPluginVersion(latest);

    const allServers = await liveServers();
    for (const server of allServers) {
      if (!isJellyfinEmby(server.type)) continue;
      if (sseManager.isInFallback(server.id)) continue;

      const installed = sseManager.getPluginVersion(server.id);
      const outdated = installed === null || compareVersions(installed, latest) < 0;
      if (!outdated) {
        nudgedVersions.delete(server.id);
        continue;
      }
      if (nudgedVersions.get(server.id) === latest) continue;

      nudgedVersions.set(server.id, latest);
      await dispatchPluginUpdate({
        server: { id: server.id, name: server.name, type: server.type },
        installedVersion: installed,
        latestVersion: latest,
        downloadUrl: RELEASES_URL,
      });
      console.log(
        `[PluginUpdate] ${server.name}: plugin ${installed ?? 'pre-0.2.0'} -> ${latest} available`
      );
    }
  } catch (error) {
    console.error('[PluginUpdate] Check failed:', error);
  }
}

export function startPluginUpdateChecker(): void {
  if (timers) return;
  // The initial delay waits for SSE connections and their hello frames to land
  timers = startPeriodic(INITIAL_DELAY_MS, CHECK_INTERVAL_MS, runPluginUpdateCheck);
  console.log('[PluginUpdate] Checker started (every 6h)');
}

export function stopPluginUpdateChecker(): void {
  timers?.stop();
  timers = null;
}
