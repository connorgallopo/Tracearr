/**
 * Live server stats (CPU/RAM and bandwidth). Plex is fetched behind a short
 * Redis cache; Jellyfin/Emby arrive as SSE plugin events into a rolling
 * buffer, so their charts empty when a plugin goes quiet.
 */

import type { Redis } from 'ioredis';
import {
  BANDWIDTH_STATS_CONFIG,
  CACHE_TTL,
  liveStatsRetentionSeconds,
  REDIS_KEYS,
  SERVER_PROFILES,
  SERVER_STATS_CONFIG,
  assertNever,
  type ServerType,
} from '@tracearr/shared';
import type { ServerResourceDataPoint } from '@tracearr/shared';
import { PlexClient } from './mediaServer/plex/client.js';
import type { PlexBandwidthStats, PlexStatisticsDataPoint } from './mediaServer/plex/parser.js';

interface ServerRow {
  id: string;
  type: ServerType;
  url: string;
  token: string;
}

type PlexServerRow = Omit<ServerRow, 'type'>;

export interface PluginStatsSample {
  at: number;
  hostCpuUtilization: number | null;
  processCpuUtilization: number | null;
  hostMemoryUtilization: number | null;
  processMemoryUtilization: number | null;
}

// SSE plugin timer period as of 0.4.x; labels the sample, never positions it
const PLUGIN_SAMPLE_INTERVAL_SECONDS = 6;

const PLUGIN_STATS_WINDOW = Math.ceil(
  (SERVER_STATS_CONFIG.WINDOW_SECONDS * 1.3) / PLUGIN_SAMPLE_INTERVAL_SECONDS
);

// Outlives the chart window so a dropped plugin drains rather than blanking
const PLUGIN_STATS_TTL_SECONDS = SERVER_STATS_CONFIG.WINDOW_SECONDS * 2;

// Coalesce concurrent misses per key so a hung upstream (10s client timeout)
// costs one in-flight request instead of one per poll tick per viewer
const inFlight = new Map<string, Promise<unknown>>();

async function cachedFetch<T>(
  redis: Redis,
  key: string,
  ttlSeconds: number,
  fetch: () => Promise<T>
): Promise<T> {
  try {
    const hit = await redis.get(key);
    if (hit) return JSON.parse(hit) as T;
  } catch {
    // Redis unavailable or corrupt entry; fall through to a live fetch
  }

  const pending = inFlight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = (async () => {
    const value = await fetch();
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(value));
    } catch {
      // Cache write is best-effort
    }
    return value;
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, promise);
  return promise;
}

export async function getServerResourceStats(
  redis: Redis,
  server: PlexServerRow
): Promise<PlexStatisticsDataPoint[]> {
  return cachedFetch(
    redis,
    REDIS_KEYS.SERVER_STATS_RESOURCES(server.id),
    CACHE_TTL.SERVER_STATS_RESOURCES,
    () =>
      new PlexClient({ url: server.url, token: server.token }).getServerStatistics(
        SERVER_STATS_CONFIG.TIMESPAN_PARAM
      )
  );
}

export async function getServerBandwidthStats(
  redis: Redis,
  server: PlexServerRow
): Promise<PlexBandwidthStats> {
  return cachedFetch(
    redis,
    REDIS_KEYS.SERVER_STATS_BANDWIDTH(server.id),
    CACHE_TTL.SERVER_STATS_BANDWIDTH,
    async () =>
      trimBandwidthStats(
        await new PlexClient({ url: server.url, token: server.token }).getServerBandwidth(
          BANDWIDTH_STATS_CONFIG.TIMESPAN_PARAM
        ),
        liveStatsRetentionSeconds(BANDWIDTH_STATS_CONFIG.WINDOW_SECONDS)
      )
  );
}

// Plex answers with its whole per-second history, which can run past a day of
// rows; clients only chart the live window. Measured from Plex's own newest
// point, so a server with a wrong clock keeps its window.
export function trimBandwidthStats(
  stats: PlexBandwidthStats,
  windowSeconds: number
): PlexBandwidthStats {
  const newest = newestAt(stats.points);
  if (newest === 0) return stats;

  const cutoff = newest - windowSeconds;
  const samples = stats.samples.filter((s) => s.at >= cutoff);
  const accountIds = new Set(samples.map((s) => s.accountId));
  const deviceIds = new Set(samples.map((s) => s.deviceId));

  return {
    points: stats.points.filter((p) => p.at >= cutoff),
    samples,
    accounts: stats.accounts.filter((a) => accountIds.has(a.id)),
    devices: stats.devices.filter((d) => deviceIds.has(d.id)),
  };
}

// A loop, not Math.max(...): spreading ~124k points overflows the call stack
function newestAt(...series: { at: number }[][]): number {
  let newest = 0;
  for (const points of series) {
    for (const p of points) {
      if (p.at > newest) newest = p.at;
    }
  }
  return newest;
}

// A corrupt entry must not block the write
function headTimestamp(entry: string | null): number | null {
  if (!entry) return null;
  try {
    return (JSON.parse(entry) as ServerResourceDataPoint).at;
  } catch {
    return null;
  }
}

export async function recordServerStatsSample(
  redis: Redis,
  serverId: string,
  sample: PluginStatsSample
): Promise<void> {
  // Process metrics are the floor; host metrics stay null on non-Linux
  // hosts and chart as gaps rather than dropping the whole sample
  if (sample.processCpuUtilization == null || sample.processMemoryUtilization == null) {
    return;
  }

  // Re-stamp with our clock - the plugin sends its host's, and a drifting
  // host shifts its whole line against the others
  const point: ServerResourceDataPoint = {
    at: Math.floor(Date.now() / 1000),
    timespan: PLUGIN_SAMPLE_INTERVAL_SECONDS,
    hostCpuUtilization: sample.hostCpuUtilization,
    processCpuUtilization: sample.processCpuUtilization,
    hostMemoryUtilization: sample.hostMemoryUtilization,
    processMemoryUtilization: sample.processMemoryUtilization,
  };

  const key = REDIS_KEYS.SERVER_STATS_SAMPLES(serverId);
  try {
    // Best-effort: calls are concurrent, so a race can still let both
    // through. The client dedupes by timestamp anyway.
    if (headTimestamp(await redis.lindex(key, 0)) === point.at) return;

    await redis
      .multi()
      .lpush(key, JSON.stringify(point))
      .ltrim(key, 0, PLUGIN_STATS_WINDOW - 1)
      .expire(key, PLUGIN_STATS_TTL_SECONDS)
      .exec();
  } catch {
    // Best-effort; a missed sample is one gap in a rolling chart
  }
}

export async function getPluginServerStats(
  redis: Redis,
  serverId: string
): Promise<ServerResourceDataPoint[]> {
  try {
    const raw = await redis.lrange(REDIS_KEYS.SERVER_STATS_SAMPLES(serverId), 0, -1);
    return raw.flatMap((entry) => {
      try {
        return [JSON.parse(entry) as ServerResourceDataPoint];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

// Past this, the gap is a wrong clock rather than sampling lag
const MAX_PLAUSIBLE_LAG_SECONDS = 15;

/** Seconds to shift a Plex server's timestamps onto our clock. Zero when the
 *  gap reads as sampling lag, so a synced server keeps its own timestamps. */
export function plexClockShift(...series: { at: number }[][]): number {
  const newest = newestAt(...series);
  if (newest === 0) return 0;

  const lag = Math.floor(Date.now() / 1000) - newest;
  return lag - Math.min(Math.max(lag, 0), MAX_PLAUSIBLE_LAG_SECONDS);
}

function shiftPoints<T extends { at: number }>(points: T[], shift: number): T[] {
  return shift === 0 ? points : points.map((p) => ({ ...p, at: p.at + shift }));
}

export async function getServerLiveStats(redis: Redis, server: ServerRow) {
  const hostStats = SERVER_PROFILES[server.type].hostStats;
  switch (hostStats) {
    case 'plexStatistics':
      return getPlexLiveStats(redis, server);
    case 'ssePlugin':
      return {
        statistics: await getPluginServerStats(redis, server.id),
        bandwidth: [],
        bandwidthSamples: [],
        bandwidthAccounts: [],
        bandwidthDevices: [],
      };
    default:
      return assertNever(hostStats);
  }
}

async function getPlexLiveStats(redis: Redis, server: PlexServerRow) {
  const [statistics, bandwidthStats] = await Promise.all([
    getServerResourceStats(redis, server),
    getServerBandwidthStats(redis, server),
  ]);

  // One absolute axis for every server, so an unsynced Plex box would draw
  // off it entirely. After the cache, so the shift is fresh.
  const shift = plexClockShift(statistics, bandwidthStats.points);

  return {
    statistics: shiftPoints(statistics, shift),
    bandwidth: shiftPoints(bandwidthStats.points, shift),
    bandwidthSamples: shiftPoints(bandwidthStats.samples, shift),
    bandwidthAccounts: bandwidthStats.accounts,
    bandwidthDevices: bandwidthStats.devices,
  };
}
