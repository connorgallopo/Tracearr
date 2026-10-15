/**
 * What each media server runs and what its vendor ships, every six hours on the leader.
 * Both versions land on the server row; a newer release nudges once per version.
 */

import { eq } from 'drizzle-orm';
import type { ServerType } from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { dispatchServerUpdate } from '../services/automations/events/producers.js';
import { createMediaServerClient } from '../services/mediaServer/index.js';
import { liveServers } from '../services/liveServers.js';
import { getSettings } from '../services/settings.js';
import { createLogger } from '../utils/logger.js';
import { startPeriodic, type PeriodicTimers } from '../utils/periodic.js';
import {
  SERVER_RELEASE_PAGES,
  isNewerServerVersion,
  latestVersionFor,
  normalizeServerVersion,
} from '../utils/serverVersions.js';

const logger = createLogger('ServerUpdate');

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const INITIAL_DELAY_MS = 15_000;

export interface CheckedServer {
  id: string;
  name: string;
  type: ServerType;
  url: string;
  token: string;
}

let timers: PeriodicTimers | null = null;
// serverId -> latest version already nudged for; re-arms when a newer release lands
const nudgedVersions = new Map<string, string>();

export function _resetServerUpdateStateForTests(): void {
  nudgedVersions.clear();
}

/**
 * Both columns hold normalized versions, so everything downstream compares them as
 * strings. An unreachable or unparseable server keeps whatever the row already holds.
 */
export async function installedVersionOf(server: CheckedServer): Promise<string | null> {
  let reported: string | null;
  try {
    const client = createMediaServerClient({
      type: server.type,
      url: server.url,
      token: server.token,
      id: server.id,
    });
    reported = (await client.getSoftwareVersion?.()) ?? null;
  } catch (error) {
    logger.warn(`${server.name}: could not read its version`, { error });
    return null;
  }
  if (!reported) return null;
  const normalized = normalizeServerVersion(server.type, reported);
  if (!normalized) logger.debug(`${server.name}: unreadable version ${reported}`);
  return normalized;
}

async function checkServer(server: CheckedServer, latest: string | null): Promise<void> {
  const installed = await installedVersionOf(server);

  const patch: { version?: string; latestVersion?: string } = {};
  if (installed) patch.version = installed;
  if (latest) patch.latestVersion = latest;
  if (installed ?? latest) {
    // One server's write failing leaves the rest of the sweep to run.
    try {
      await db
        .update(servers)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(servers.id, server.id));
    } catch (error) {
      logger.warn(`${server.name}: could not store its version`, { error });
    }
  }

  if (!installed || !latest) return;
  if (!isNewerServerVersion(server.type, latest, installed)) {
    nudgedVersions.delete(server.id);
    return;
  }
  if (nudgedVersions.get(server.id) === latest) return;

  nudgedVersions.set(server.id, latest);
  await dispatchServerUpdate({
    server: { id: server.id, name: server.name, type: server.type },
    installedVersion: installed,
    latestVersion: latest,
    releaseUrl: SERVER_RELEASE_PAGES[server.type],
  });
  logger.info(`${server.name}: ${installed} -> ${latest} available`);
}

export async function runServerUpdateCheck(): Promise<void> {
  try {
    const settings = await getSettings(['serverUpdateCheckEnabled']);
    if (!settings.serverUpdateCheckEnabled) return;

    const rows = await liveServers();

    // The vendor feed is per type, not per server: read it once however many servers share it.
    const latestByType = new Map<ServerType, Promise<string | null>>();
    for (const server of rows) {
      let latest = latestByType.get(server.type);
      if (!latest) {
        latest = latestVersionFor(server.type);
        latestByType.set(server.type, latest);
      }
      await checkServer(server, await latest);
    }
  } catch (error) {
    logger.error('Check failed', { error });
  }
}

export function startServerUpdateChecker(): void {
  if (timers) return;
  timers = startPeriodic(INITIAL_DELAY_MS, CHECK_INTERVAL_MS, runServerUpdateCheck);
  logger.info('Checker started (every 6h)');
}

export function stopServerUpdateChecker(): void {
  timers?.stop();
  timers = null;
}
