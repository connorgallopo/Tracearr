import { REDIS_KEYS, SERVER_TYPES } from '@tracearr/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';
import { getRedis } from '../../lib/redisShared.js';
import { liveServerCondition, type ServerRow } from '../liveServers.js';
import { createJellyfinEmbyClient, isJellyfinEmby } from '../mediaServer/index.js';
import { getServerUserIdByExternalId } from '../../jobs/poller/database.js';
import { deliveredFile } from './enrich.js';
import { recordDownload, type DownloadSignal } from './recorder.js';
import { pollServerTranscodePulls } from './transcodePull.js';
import type {
  BaseMediaServerClient,
  JellyfinEmbyActivityEntry,
} from '../mediaServer/shared/baseMediaServerClient.js';
import type { EmbySyncJob, EmbySyncJobItem } from '../mediaServer/shared/jellyfinEmbyParser.js';

const DOWNLOAD_ENTRY_TYPE = 'UserDownloadingContent';
const SEED_WINDOW_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 100;

// Jellyfin "<user> is downloading <title>", Emby "<user> is Downloading <title>"
const TITLE_PATTERN = / is downloading (.+)$/i;
// Jellyfin "App: <app>, Device: <device>", Emby "From <server> with <app> on <device>"
const APP_DEVICE_PATTERNS = [/^App: (.+), Device: (.+)$/, /^From .+? with (.+) on (.+)$/];
// Emby sync TargetName "<device> (<app>) - <user>"
const SYNC_TARGET_PATTERN = /^(.+?) \((.+?)\) - /;
// Emby SyncJobItemStatus values before an item ends Synced, Failed, Cancelled or RemovedFromDevice
const SYNC_PENDING_STATUSES = new Set(['Queued', 'Converting', 'ReadyToTransfer', 'Transferring']);
const SYNC_RECORDED_TTL_SECONDS = 30 * 24 * 60 * 60;

type ActivityLogClient = BaseMediaServerClient;

const inFlight = new Set<string>();

async function exclusive(key: string, run: () => Promise<void>): Promise<void> {
  if (inFlight.has(key)) return;
  inFlight.add(key);
  try {
    await run();
  } finally {
    inFlight.delete(key);
  }
}

async function resolveServerUserId(
  server: ServerRow,
  client: ActivityLogClient,
  userId: string | null
): Promise<string | null> {
  const externalId = userId ? await client.resolveUserGuid(userId) : null;
  return externalId ? getServerUserIdByExternalId(server.id, externalId) : null;
}

async function readEntries(
  client: ActivityLogClient,
  cursor: number | null
): Promise<JellyfinEmbyActivityEntry[]> {
  const seed = () =>
    client.getActivityLog({ minDate: new Date(Date.now() - SEED_WINDOW_MS), hasUserId: true });
  if (cursor === null) return seed();
  const page = await client.getActivityLog({ limit: PAGE_SIZE, hasUserId: true });
  // A full page past the cursor means entries may have scrolled off it while Tracearr was down
  return page.length === PAGE_SIZE && page.every((entry) => entry.id > cursor) ? seed() : page;
}

function parseAppDevice(shortOverview: string | undefined): {
  app: string | null;
  device: string | null;
} {
  for (const pattern of APP_DEVICE_PATTERNS) {
    const match = pattern.exec(shortOverview ?? '');
    if (match) return { app: match[1] ?? null, device: match[2] ?? null };
  }
  return { app: null, device: null };
}

async function toSignal(
  server: ServerRow,
  client: ActivityLogClient,
  entry: JellyfinEmbyActivityEntry
): Promise<DownloadSignal> {
  return {
    serverId: server.id,
    serverUserId: await resolveServerUserId(server, client, entry.userId ?? null),
    ratingKey: entry.itemId ?? null,
    title: TITLE_PATTERN.exec(entry.name)?.[1] ?? entry.name,
    ...parseAppDevice(entry.shortOverview),
    source: 'activity_log',
    seenAt: new Date(entry.date),
  };
}

async function pollServer(server: ServerRow): Promise<void> {
  const { type } = server;
  if (!isJellyfinEmby(type)) return;
  await exclusive(server.id, async () => {
    const client = createJellyfinEmbyClient(type, server);
    const redis = getRedis();
    const key = REDIS_KEYS.DOWNLOAD_CURSOR(server.id);
    const stored = await redis.get(key);
    const cursor = stored === null ? null : Number(stored);

    const entries = (await readEntries(client, cursor))
      .filter((entry) => cursor === null || entry.id > cursor)
      .sort((a, b) => a.id - b.id);

    let last = cursor;
    try {
      for (const entry of entries) {
        if (entry.type === DOWNLOAD_ENTRY_TYPE) {
          // One bad entry must not hold the cursor, or no later download on the server records
          await recordDownload(await toSignal(server, client, entry)).catch((error: unknown) => {
            console.error(`[Downloads] Entry ${entry.id} on ${server.name} not recorded:`, error);
          });
        }
        last = entry.id;
      }
    } finally {
      if (last !== null && last !== cursor) await redis.set(key, String(last));
    }
  });
}

function syncSignal(
  server: ServerRow,
  job: EmbySyncJob,
  item: EmbySyncJobItem,
  serverUserId: string | null,
  seenAt: Date
): DownloadSignal {
  const target = SYNC_TARGET_PATTERN.exec(job.targetName);
  const source = item.mediaSource;
  return {
    serverId: server.id,
    serverUserId,
    ratingKey: item.itemId,
    title: job.name,
    app: target?.[2] ?? null,
    device: target?.[1] ?? null,
    source: 'emby_sync',
    seenAt,
    deviceId: job.targetId || null,
    delivered: source && deliveredFile(source, source.size),
  };
}

async function pollSync(server: ServerRow): Promise<void> {
  const { type } = server;
  if (!isJellyfinEmby(type)) return;
  await exclusive(`sync:${server.id}`, async () => {
    const client = createJellyfinEmbyClient(type, server);
    const redis = getRedis();
    const cursorKey = REDIS_KEYS.SYNC_CURSOR(server.id);
    const recordedKey = REDIS_KEYS.SYNC_RECORDED(server.id);
    const stored = await redis.get(cursorKey);
    const cursor = stored === null ? null : Number(stored);
    const [jobs, items] = await Promise.all([client.getSyncJobs(), client.getSyncJobItems()]);
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    // The first run takes the last 24 h, so old app downloads are not stamped with today's address
    const seedFrom = cursor === null ? Date.now() - SEED_WINDOW_MS : null;

    let lowestPending = Infinity;
    let highestDone = cursor ?? 0;
    for (const item of items.filter((i) => i.id > (cursor ?? 0))) {
      if (SYNC_PENDING_STATUSES.has(item.status)) {
        lowestPending = Math.min(lowestPending, item.id);
        continue;
      }
      const job = jobsById.get(item.jobId);
      const inWindow = seedFrom === null || new Date(item.dateCreated).getTime() >= seedFrom;
      if (
        item.status === 'Synced' &&
        job &&
        inWindow &&
        !(await redis.sismember(recordedKey, String(item.id)))
      ) {
        const serverUserId = await resolveServerUserId(server, client, job.userId);
        // A long-lived job's DateLastModified can predate the item finishing; past the seed the poll time is closer
        const seenAt = seedFrom === null ? new Date() : new Date(job.dateLastModified);
        await recordDownload(syncSignal(server, job, item, serverUserId, seenAt));
        await redis.sadd(recordedKey, String(item.id));
      }
      highestDone = Math.max(highestDone, item.id);
    }
    // A pending item can hold the cursor for weeks; the set must outlive it or the items past it record again
    await redis.expire(recordedKey, SYNC_RECORDED_TTL_SECONDS);
    // Below the cursor every item is finished; a pending one holds it so it is still walked
    const next = Math.min(lowestPending - 1, highestDone);
    if (next !== cursor) await redis.set(cursorKey, String(next));
  });
}

/** Reads new UserDownloadingContent entries after the server's cursor (seeded 24 h back), records each, advances the cursor. Drops the run if one is already in flight for the server. */
export async function pollServerDownloads(serverId: string): Promise<void> {
  const [server] = await db
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.id, serverId),
        inArray(servers.type, SERVER_TYPES.filter(isJellyfinEmby)),
        liveServerCondition
      )
    )
    .limit(1);
  if (server) await pollServer(server);
}

/** Records each sync job item (an Emby app download) once, when it reaches Synced; seeded 24 h back. */
export async function pollServerSyncJobs(serverId: string): Promise<void> {
  const [server] = await db
    .select()
    .from(servers)
    .where(
      and(
        eq(servers.id, serverId),
        inArray(servers.type, SERVER_TYPES.filter(isJellyfinEmby)),
        liveServerCondition
      )
    )
    .limit(1);
  if (server) await pollSync(server);
}

export async function pollAllDownloads(): Promise<void> {
  const rows = await db
    .select()
    .from(servers)
    .where(and(inArray(servers.type, SERVER_TYPES.filter(isJellyfinEmby)), liveServerCondition));
  await Promise.all(
    rows.flatMap((server) => [
      pollServer(server).catch((error: unknown) => {
        console.error(`[Downloads] Activity log poll failed for ${server.name}:`, error);
      }),
      pollSync(server).catch((error: unknown) => {
        console.error(`[Downloads] Sync job poll failed for ${server.name}:`, error);
      }),
      pollServerTranscodePulls(server).catch((error: unknown) => {
        console.error(`[Downloads] Transcode pull poll failed for ${server.name}:`, error);
      }),
    ])
  );
}
