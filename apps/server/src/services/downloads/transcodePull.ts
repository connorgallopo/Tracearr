import { and, desc, eq, gte } from 'drizzle-orm';
import { REDIS_KEYS } from '@tracearr/shared';
import { db } from '../../db/client.js';
import { mediaDownloads } from '../../db/schema.js';
import { getRedis } from '../../lib/redisShared.js';
import { createJellyfinEmbyClient, isJellyfinEmby } from '../mediaServer/index.js';
import { createLogger } from '../../utils/logger.js';
import { getServerUserIdByExternalId } from '../../jobs/poller/database.js';
import { deliveredFile, enrichDownload, sourceColumns } from './enrich.js';
import { insertDownload, matchLibraryItem, type DownloadSignal } from './recorder.js';
import type { ServerRow } from '../liveServers.js';
import type { PluginTranscodePullEvent } from '../mediaServer/shared/jellyfinEmbyEventSource.js';

export const TRANSCODE_PULL_MIN_AGE_MS = 20_000;
export const CONVERTED_DOWNLOAD_TITLE = 'Converted download';

// The plugin reports ended within 5 s of the transcode stopping; a poll that closed the row first did so moments earlier
const ENDED_AFTER_CLOSE_MS = 60_000;

/** When the pull was first seen, its row once opened, and its last non-null completion */
interface Pull {
  since: number;
  rowId: string | null;
  completion: number | null;
}

type Pulls = Map<string, Pull>;

const queues = new Map<string, Promise<void>>();

const logger = createLogger('downloads');

// The poll and the plugin events share one state per server; taking turns keeps a pull to one row
async function withPulls(serverId: string, run: (pulls: Pulls) => Promise<void>): Promise<void> {
  const turn = (queues.get(serverId) ?? Promise.resolve()).then(async () => {
    const redis = getRedis();
    const key = REDIS_KEYS.TRANSCODE_PULLS(serverId);
    const stored = (await redis.get(key)) ?? '{}';
    const pulls: Pulls = new Map(Object.entries(JSON.parse(stored) as Record<string, Pull>));
    try {
      await run(pulls);
    } finally {
      const next = JSON.stringify(Object.fromEntries(pulls));
      if (next !== stored) await redis.set(key, next);
    }
  });
  queues.set(
    serverId,
    turn.catch(() => undefined)
  );
  return turn;
}

async function serverUserId(serverId: string, userId: string | null): Promise<string | null> {
  return userId ? getServerUserIdByExternalId(serverId, userId) : null;
}

async function updateRow(
  rowId: string,
  values: Partial<typeof mediaDownloads.$inferInsert>
): Promise<void> {
  await db.update(mediaDownloads).set(values).where(eq(mediaDownloads.id, rowId));
}

// A pull saved before completion was stored reads back without the field
function completionPercent(completion: number | null | undefined) {
  return completion == null ? {} : { completionPercent: Math.round(completion) };
}

/**
 * Opens a jellyfin_transcode download for each device session whose transcoding completion is
 * non-null with nothing playing for 20 s, and closes it when completion turns null or the info
 * disappears; a non-null value after that is a new pull. Jellyfin never clears TranscodingInfo
 * on a session that is not playing (verified 2026-10-20).
 */
export async function pollServerTranscodePulls(server: ServerRow): Promise<void> {
  if (!isJellyfinEmby(server.type)) return;
  const client = createJellyfinEmbyClient(server.type, server);
  const sessions = await client.getTranscodePullSessions();
  await withPulls(server.id, async (pulls) => {
    const now = Date.now();
    const pulling = new Set<string>();
    for (const session of sessions) {
      const { deviceId, transcoding } = session;
      if (!deviceId || session.nowPlaying || transcoding?.completionPercentage == null) continue;
      pulling.add(deviceId);
      const pull = pulls.get(deviceId) ?? { since: now, rowId: null, completion: null };
      pull.completion = transcoding.completionPercentage;
      pulls.set(deviceId, pull);
      if (pull.rowId || now - pull.since < TRANSCODE_PULL_MIN_AGE_MS) continue;
      try {
        const row = await insertDownload(
          {
            serverId: server.id,
            serverUserId: await serverUserId(server.id, session.userId),
            ratingKey: null,
            title: CONVERTED_DOWNLOAD_TITLE,
            app: session.client,
            device: session.deviceName,
            source: 'jellyfin_transcode',
            seenAt: new Date(pull.since),
            deviceId,
            delivered: deliveredFile(transcoding, null),
          },
          null
        );
        pull.rowId = row.id;
      } catch (error) {
        logger.warn('Converted download failed to open; retrying next tick', {
          serverId: server.id,
          deviceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    for (const [deviceId, pull] of pulls) {
      if (pulling.has(deviceId)) continue;
      pulls.delete(deviceId);
      if (pull.rowId) {
        await updateRow(pull.rowId, {
          lastSeenAt: new Date(now),
          ...completionPercent(pull.completion),
        });
      }
    }
  });
}

async function closedRowId(serverId: string, deviceId: string, now: Date): Promise<string | null> {
  const [row] = await db
    .select({ id: mediaDownloads.id })
    .from(mediaDownloads)
    .where(
      and(
        eq(mediaDownloads.serverId, serverId),
        eq(mediaDownloads.deviceId, deviceId),
        eq(mediaDownloads.source, 'jellyfin_transcode'),
        gte(mediaDownloads.lastSeenAt, new Date(now.getTime() - ENDED_AFTER_CLOSE_MS))
      )
    )
    .orderBy(desc(mediaDownloads.firstSeenAt))
    .limit(1);
  return row?.id ?? null;
}

/** Plugin events carry what REST cannot: the item and the bytes transcoded. */
export async function recordTranscodePullEvent(
  serverId: string,
  event: PluginTranscodePullEvent
): Promise<void> {
  await withPulls(serverId, async (pulls) => {
    const pull = pulls.get(event.deviceId);
    const now = new Date();

    if (event.phase === 'ended') {
      pulls.delete(event.deviceId);
      const final = {
        ...(event.bytesTranscoded === null ? {} : { deliveredBytes: event.bytesTranscoded }),
        ...completionPercent(event.completionPercentage ?? pull?.completion ?? null),
      };
      if (pull?.rowId) {
        await updateRow(pull.rowId, { lastSeenAt: now, ...final });
      } else if (Object.keys(final).length > 0) {
        const rowId = await closedRowId(serverId, event.deviceId, now);
        if (rowId) await updateRow(rowId, final);
      }
      return;
    }

    const item = event.itemId
      ? await matchLibraryItem({
          serverId,
          ratingKey: event.itemId,
          title: CONVERTED_DOWNLOAD_TITLE,
        })
      : null;
    const libraryItemId = item?.id ?? null;
    // The plugin waited out the same 20 s before reporting a pull the poll has not seen
    const since = pull?.since ?? now.getTime() - TRANSCODE_PULL_MIN_AGE_MS;
    const signal: DownloadSignal = {
      serverId,
      serverUserId: await serverUserId(serverId, event.userId),
      ratingKey: event.itemId,
      title: item?.title ?? CONVERTED_DOWNLOAD_TITLE,
      app: null,
      device: null,
      source: 'jellyfin_transcode',
      seenAt: new Date(since),
      deviceId: event.deviceId,
      delivered: deliveredFile(event, null),
    };
    const completion = event.completionPercentage ?? pull?.completion ?? null;

    if (pull?.rowId) {
      pull.completion = completion;
      if (event.itemId) {
        const enrichment = await enrichDownload({ ...signal, libraryItemId });
        await updateRow(pull.rowId, {
          ratingKey: event.itemId,
          libraryItemId,
          title: signal.title,
          ...sourceColumns(enrichment),
        });
      }
      return;
    }

    const row = await insertDownload(signal, libraryItemId);
    pulls.set(event.deviceId, { since, rowId: row.id, completion });
  });
}
