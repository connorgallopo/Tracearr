/**
 * Version Check Queue - BullMQ-based periodic version checking
 *
 * Checks GitHub releases for new versions and caches the result.
 * Broadcasts update availability to connected clients via pub/sub.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { getBullPrefix, queueConnectionOptions } from './queueConnection.js';
import { isMaintenance } from '../serverState.js';
import {
  REDIS_KEYS,
  CACHE_TTL,
  WS_EVENTS,
  compareVersions,
  getBaseVersion,
  isNewerVersion,
  isPrerelease,
  releaseNotesFileSchema,
  type UpgradeWarning,
} from '@tracearr/shared';
import { getBuildInfo, getCurrentVersion } from '../utils/buildInfo.js';
import { dispatchTracearrUpdate } from '../services/automations/events/producers.js';

// Queue name
const QUEUE_NAME = 'version-check';

// Minimum interval between GitHub fetches (15 min); the 6h scheduler far exceeds this
const MIN_VERSION_CHECK_INTERVAL_S = 15 * 60;

// Thrown when GitHub signals a rate limit (403/429); carries the pause duration
export class GitHubRateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number) {
    super(
      `GitHub rate limited; pausing version checks for ~${Math.round(retryAfterSeconds / 60)}m`
    );
    this.name = 'GitHubRateLimitError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

// GitHub API configuration
const UPSTREAM_API_LATEST_URL =
  'https://api.github.com/repos/connorgallopo/Tracearr/releases/latest';
const UPSTREAM_API_ALL_RELEASES_URL =
  'https://api.github.com/repos/connorgallopo/Tracearr/releases';
const UPSTREAM_RELEASES_URL = 'https://github.com/connorgallopo/Tracearr/releases';
const FORK_API_ALL_RELEASES_URL = 'https://api.github.com/repos/d4rk-4lchemy/Tracearr/releases';
const FORK_RELEASES_URL = 'https://github.com/d4rk-4lchemy/Tracearr/releases';

// Job types
interface VersionCheckJobData {
  type: 'check';
  force?: boolean;
}

// Latest version info stored in Redis
export interface LatestVersionData {
  version: string;
  tag: string;
  releaseUrl: string;
  publishedAt: string;
  checkedAt: string;
  isPrerelease: boolean;
  releaseName: string | null;
  releaseNotes: string | null;
  upgradeWarnings: UpgradeWarning[];
}

export interface LatestForkReleaseData extends LatestVersionData {
  upstreamVersion: string;
  forkRevision: number;
  forkVersion: string;
}

export interface ParsedForkVersion {
  upstreamVersion: string;
  forkRevision: number;
  forkVersion: string;
  tag: string;
}

// Connection options (set during initialization)
let connectionOptions: ConnectionOptions | null = null;

// Queue and worker instances
let versionQueue: Queue<VersionCheckJobData> | null = null;
let versionWorker: Worker<VersionCheckJobData> | null = null;

// Redis client for caching and pub/sub
let redisClient: Redis | null = null;

// Pub/sub service for broadcasting updates
let pubSubPublish: ((event: string, data: unknown) => Promise<void>) | null = null;

/**
 * Initialize the version check queue with Redis connection
 */
export function initVersionCheckQueue(
  redisUrl: string,
  redis: Redis,
  publishFn: (event: string, data: unknown) => Promise<void>
): void {
  if (versionQueue) {
    console.log('Version check queue already initialized');
    return;
  }

  connectionOptions = queueConnectionOptions(redisUrl);
  redisClient = redis;
  pubSubPublish = publishFn;
  const bullPrefix = getBullPrefix();

  // Create the version check queue
  versionQueue = new Queue<VersionCheckJobData>(QUEUE_NAME, {
    connection: connectionOptions,
    prefix: bullPrefix,
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 5000, // 5s, 10s, 20s
      },
      removeOnComplete: {
        count: 10, // Keep last 10 for debugging
        age: 24 * 60 * 60, // 24 hours
      },
      removeOnFail: {
        count: 50,
        age: 7 * 24 * 60 * 60, // 7 days
      },
    },
  });
  versionQueue.on('error', (err) => {
    if (!isMaintenance()) console.error('Version check queue error:', err);
  });

  console.log('Version check queue initialized');
}

/**
 * Start the version check worker
 */
export function startVersionCheckWorker(): void {
  if (!connectionOptions) {
    throw new Error('Version check queue not initialized. Call initVersionCheckQueue first.');
  }

  if (versionWorker) {
    console.log('Version check worker already running');
    return;
  }

  const bullPrefix = getBullPrefix();

  versionWorker = new Worker<VersionCheckJobData>(
    QUEUE_NAME,
    async (job: Job<VersionCheckJobData>) => {
      const startTime = Date.now();
      try {
        await processVersionCheck(job);
        const duration = Date.now() - startTime;
        console.log(`Version check job ${job.id} completed in ${duration}ms`);
      } catch (error) {
        const duration = Date.now() - startTime;
        console.error(`Version check job ${job.id} failed after ${duration}ms:`, error);
        throw error;
      }
    },
    {
      connection: connectionOptions,
      prefix: bullPrefix,
      concurrency: 1, // Only one check at a time
    }
  );

  versionWorker.on('error', (error) => {
    if (!isMaintenance()) console.error('Version check worker error:', error);
  });

  console.log('Version check worker started');
}

/**
 * Schedule repeating version checks (every 6 hours)
 */
export async function scheduleVersionChecks(): Promise<void> {
  if (!versionQueue) {
    console.error('Version check queue not initialized');
    return;
  }

  // Remove any existing job schedulers; BullMQ reports them by key, not id.
  const schedulers = await versionQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    await versionQueue.removeJobScheduler(scheduler.key);
  }

  // Schedule a check every 6 hours (4 times per day)
  await versionQueue.add(
    'scheduled-check',
    { type: 'check' },
    {
      repeat: {
        every: CACHE_TTL.VERSION_CHECK * 1000, // 6 hours in milliseconds
      },
      jobId: 'version-check-repeatable',
    }
  );

  // Use a fresh startup job on every process start. A stable id can refer to a
  // previously completed BullMQ job, in which case BullMQ silently refuses to
  // enqueue it and a new cache namespace never gets populated after upgrade.
  // The cooldown key still prevents restart bursts from hammering GitHub.
  await versionQueue.add(
    'startup-check',
    { type: 'check' },
    { jobId: `startup-check-${Date.now()}` }
  );

  console.log('Version checks scheduled (every 6 hours)');
}

/**
 * Force an immediate version check
 */
export async function forceVersionCheck(): Promise<void> {
  if (!versionQueue) {
    console.error('Version check queue not initialized');
    return;
  }

  await versionQueue.add(
    'forced-check',
    { type: 'check', force: true },
    { jobId: `forced-${Date.now()}` }
  );
}

// GitHub release structure from API
export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  name: string;
  body: string | null;
  prerelease: boolean;
  draft: boolean;
  assets?: { name: string; browser_download_url: string }[];
}

/**
 * Fetch releases from GitHub API.
 * Best-effort/informational; on rate limit or error it degrades to the cached
 * last-known version and must never spiral or crash.
 */
export async function fetchGitHubReleases(
  url: string
): Promise<GitHubRelease[] | GitHubRelease | null> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Tracearr-Version-Check',
    },
  });

  if (!response.ok) {
    // GitHub uses 403 (primary limit) and 429 (secondary) for rate limiting; treat both the same
    if (response.status === 403 || response.status === 429) {
      // Compute pause duration from headers; fall back to 1h if absent
      const retryAfterHeader = response.headers.get('retry-after');
      const resetHeader = response.headers.get('x-ratelimit-reset');
      let seconds: number;
      if (retryAfterHeader) {
        seconds = parseInt(retryAfterHeader, 10);
      } else if (resetHeader) {
        seconds = parseInt(resetHeader, 10) - Math.floor(Date.now() / 1000);
      } else {
        seconds = 3600;
      }
      // retry-after can be an HTTP-date and reset can be malformed — fall back if not a number
      if (!Number.isFinite(seconds)) {
        seconds = 3600;
      }
      // Clamp to [15min, 6h]
      seconds = Math.max(MIN_VERSION_CHECK_INTERVAL_S, Math.min(seconds, 6 * 60 * 60));
      console.warn(
        `GitHub rate limit hit; pausing version checks for ~${Math.round(seconds / 60)}m`
      );
      throw new GitHubRateLimitError(seconds);
    }

    // 404 means no releases yet - not an error
    if (response.status === 404) {
      console.log('No releases found on GitHub');
      return null;
    }

    throw new Error(`GitHub API returned ${response.status}`);
  }

  return response.json() as Promise<GitHubRelease[] | GitHubRelease>;
}

/**
 * Find the best update target for a prerelease user: the newest release
 * overall. When a stable supersedes the user's beta line it IS the newest
 * (1.4.1-beta.17 is offered 1.4.3), but a newer beta line past the last
 * stable must win too - preferring stable here once hid 2.0.0-beta.1 from
 * every 1.5.0-beta user because 1.5.0 outranked their tag.
 */
export function findBestUpdateForPrerelease(
  currentVersion: string,
  releases: GitHubRelease[]
): GitHubRelease | null {
  const validReleases = releases
    .filter((r) => !r.draft)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));

  return validReleases.find((r) => compareVersions(r.tag_name, currentVersion) > 0) ?? null;
}

/** Parse only the fork's deliberate v<semver>-r<number> release convention. */
export function parseForkReleaseTag(tag: string): ParsedForkVersion | null {
  const match = tag.match(/^v(\d+\.\d+\.\d+)-r(\d+)$/);
  if (!match) return null;
  const [, upstreamVersion, revision] = match;
  if (!upstreamVersion || !revision) return null;
  const forkRevision = Number(revision);
  if (!Number.isSafeInteger(forkRevision)) return null;
  return {
    upstreamVersion,
    forkRevision,
    forkVersion: `${upstreamVersion}-r${forkRevision}`,
    tag,
  };
}

export function compareForkVersions(a: string, b: string): number {
  const parsedA = parseForkReleaseTag(a.startsWith('v') ? a : `v${a}`);
  const parsedB = parseForkReleaseTag(b.startsWith('v') ? b : `v${b}`);
  if (!parsedA || !parsedB) return 0;
  const upstreamComparison = compareVersions(parsedA.upstreamVersion, parsedB.upstreamVersion);
  return (
    upstreamComparison ||
    (parsedA.forkRevision > parsedB.forkRevision
      ? 1
      : parsedA.forkRevision < parsedB.forkRevision
        ? -1
        : 0)
  );
}

export function findLatestForkRelease(releases: GitHubRelease[]): GitHubRelease | null {
  return (
    releases
      .filter((release) => !release.draft && parseForkReleaseTag(release.tag_name))
      .sort((a, b) => compareForkVersions(b.tag_name, a.tag_name))[0] ?? null
  );
}

function toLatestData(release: GitHubRelease): LatestVersionData {
  return {
    version: release.tag_name.replace(/^v/, ''),
    tag: release.tag_name,
    releaseUrl: release.html_url || `${UPSTREAM_RELEASES_URL}/tag/${release.tag_name}`,
    publishedAt: release.published_at,
    checkedAt: new Date().toISOString(),
    isPrerelease: release.prerelease,
    releaseName: release.name || null,
    releaseNotes: release.body || null,
    upgradeWarnings: [],
  };
}

function toForkLatestData(release: GitHubRelease): LatestForkReleaseData {
  const parsed = parseForkReleaseTag(release.tag_name);
  if (!parsed) throw new Error(`Invalid fork release tag: ${release.tag_name}`);
  return {
    ...toLatestData(release),
    version: parsed.forkVersion,
    releaseUrl: release.html_url || `${FORK_RELEASES_URL}/tag/${release.tag_name}`,
    // A -rN suffix is the fork revision, not a prerelease channel. Fork
    // prerelease channels, if introduced later, must use an explicit tag
    // convention instead of inheriting GitHub's prerelease flag here.
    isPrerelease: false,
    upstreamVersion: parsed.upstreamVersion,
    forkRevision: parsed.forkRevision,
    forkVersion: parsed.forkVersion,
  };
}

const RELEASE_NOTES_ASSET = 'release-notes.json';

/**
 * Reads the release-notes.json asset of every release after the installed version up to the
 * target. Releases published before notes files existed have no asset and contribute nothing.
 */
export async function collectUpgradeWarnings(
  currentVersion: string,
  targetVersion: string,
  releases: GitHubRelease[]
): Promise<UpgradeWarning[]> {
  const targetIsPrerelease = isPrerelease(targetVersion);
  const between = releases
    .filter(
      (r) =>
        !r.draft &&
        (targetIsPrerelease || !r.prerelease) &&
        compareVersions(r.tag_name, currentVersion) > 0 &&
        compareVersions(r.tag_name, targetVersion) <= 0
    )
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));

  const warnings: UpgradeWarning[] = [];
  const collectedVersions = new Set<string>();
  for (const release of between) {
    if (collectedVersions.has(getBaseVersion(release.tag_name))) continue;
    const asset = release.assets?.find((a) => a.name === RELEASE_NOTES_ASSET);
    if (!asset) continue;
    try {
      const response = await fetch(asset.browser_download_url, {
        headers: { 'User-Agent': 'Tracearr-Version-Check' },
      });
      if (!response.ok) {
        console.warn(`Release notes for ${release.tag_name} returned ${response.status}`);
        continue;
      }
      const parsed = releaseNotesFileSchema.safeParse(await response.json());
      if (
        parsed.success &&
        parsed.data.upgradeWarning &&
        !collectedVersions.has(parsed.data.version)
      ) {
        collectedVersions.add(parsed.data.version);
        warnings.push({ version: parsed.data.version, text: parsed.data.upgradeWarning });
      }
    } catch (error) {
      console.warn(`Could not read release notes for ${release.tag_name}:`, error);
    }
  }
  return warnings;
}

/**
 * Process a version check job.
 * Best-effort/informational; on rate limit it sets a cooldown and returns
 * gracefully (no retry storm). On other errors it rethrows for BullMQ retry.
 */
export async function processVersionCheck(job: Job<VersionCheckJobData>): Promise<void> {
  if (!redisClient) {
    throw new Error('Redis client not available');
  }

  console.log(`Processing version check (job ${job.id}, force=${job.data.force ?? false})`);

  // Skip if a cooldown is active (restarts/retries collapse to a single fetch per interval)
  if (!job.data.force) {
    const coolingDown = await redisClient.exists(REDIS_KEYS.VERSION_CHECK_COOLDOWN);
    if (coolingDown) {
      console.log('Version check skipped (cooldown active)');
      return;
    }
  }

  try {
    const currentVersion = getCurrentVersion();
    const currentIsPrerelease = isPrerelease(currentVersion);

    console.log(`Current version: ${currentVersion} (prerelease: ${currentIsPrerelease})`);

    let upstreamRelease: GitHubRelease | null = null;
    let releases: GitHubRelease[] = [];

    if (currentIsPrerelease) {
      const fetched = await fetchGitHubReleases(`${UPSTREAM_API_ALL_RELEASES_URL}?per_page=30`);

      if (!fetched || !Array.isArray(fetched)) {
        console.log('No releases found or invalid response');
        return;
      }

      releases = fetched;
      const valid = releases.filter((r) => !r.draft);
      upstreamRelease = valid.sort((a, b) => compareVersions(b.tag_name, a.tag_name))[0] ?? null;
    } else {
      // For stable users, just check the latest stable release
      const release = await fetchGitHubReleases(UPSTREAM_API_LATEST_URL);

      if (!release || Array.isArray(release)) {
        console.log('No latest release found');
        return;
      }

      upstreamRelease = release;
    }

    const forkReleases = await fetchGitHubReleases(`${FORK_API_ALL_RELEASES_URL}?per_page=100`);
    if (!forkReleases || !Array.isArray(forkReleases)) {
      console.log('No fork releases found or invalid response');
      return;
    }
    const forkRelease = findLatestForkRelease(forkReleases);
    if (!upstreamRelease || !forkRelease) {
      console.log('No valid upstream or fork release found');
      return;
    }

    const latestUpstream = toLatestData(upstreamRelease);
    const latestFork = toForkLatestData(forkRelease);

    // Both channels carry upstream migration warnings only up to their own target.
    // A fork revision does not change the installed upstream version.
    if (
      releases.length === 0 &&
      (isNewerVersion(latestUpstream.version, currentVersion) ||
        isNewerVersion(latestFork.upstreamVersion, currentVersion))
    ) {
      try {
        const fetched = await fetchGitHubReleases(`${UPSTREAM_API_ALL_RELEASES_URL}?per_page=30`);
        if (Array.isArray(fetched)) releases = fetched;
      } catch (error) {
        console.warn('Could not fetch release list for upgrade warnings:', error);
      }
    }
    latestUpstream.upgradeWarnings = await collectUpgradeWarnings(
      currentVersion,
      latestUpstream.version,
      releases
    );
    latestFork.upgradeWarnings =
      latestFork.upstreamVersion === latestUpstream.version
        ? latestUpstream.upgradeWarnings
        : await collectUpgradeWarnings(currentVersion, latestFork.upstreamVersion, releases);

    // Cache each source independently.
    await redisClient.set(
      REDIS_KEYS.VERSION_LATEST_UPSTREAM,
      JSON.stringify(latestUpstream),
      'EX',
      CACHE_TTL.VERSION_CHECK
    );
    await redisClient.set(
      REDIS_KEYS.VERSION_LATEST_FORK,
      JSON.stringify(latestFork),
      'EX',
      CACHE_TTL.VERSION_CHECK
    );

    console.log(
      `Latest releases cached: fork ${latestFork.forkVersion}, upstream ${latestUpstream.version}`
    );

    // Set cooldown so restart bursts don't re-fetch immediately
    await redisClient.set(
      REDIS_KEYS.VERSION_CHECK_COOLDOWN,
      '1',
      'EX',
      MIN_VERSION_CHECK_INTERVAL_S
    );

    // Check if update is available
    const currentForkVersion = getBuildInfo().forkVersion;
    const forkUpdateAvailable =
      !!currentForkVersion && compareForkVersions(latestFork.forkVersion, currentForkVersion) > 0;
    if (forkUpdateAvailable) {
      // Broadcast update availability to connected clients
      if (pubSubPublish) {
        await pubSubPublish(WS_EVENTS.VERSION_UPDATE, {
          current: currentVersion,
          latest: latestFork.forkVersion,
          releaseUrl: latestFork.releaseUrl,
          kind: 'fork-update',
        });
      }
      // This worker runs on every instance; the cooldown above and the run gate's
      // edge key (the latest version) bound the duplicate dispatches.
      await dispatchTracearrUpdate({
        current: currentVersion,
        latest: latestFork.forkVersion,
        releaseUrl: latestFork.releaseUrl,
      });
      console.log(`Fork update available: ${currentForkVersion} -> ${latestFork.forkVersion}`);
    }
  } catch (error) {
    if (error instanceof GitHubRateLimitError) {
      // Set cooldown for the rate-limit window, then return gracefully
      await redisClient.set(REDIS_KEYS.VERSION_CHECK_COOLDOWN, '1', 'EX', error.retryAfterSeconds);
      return;
    }
    console.error('Version check failed:', error);
    throw error;
  }
}

export {
  getCurrentVersion,
  getCurrentTag,
  getCurrentCommit,
  getBuildDate,
  getBuildInfo,
} from '../utils/buildInfo.js';

/**
 * Get cached latest version from Redis
 */
async function getCachedVersion<T extends LatestVersionData>(key: string): Promise<T | null> {
  if (!redisClient) {
    return null;
  }

  const cached = await redisClient.get(key);
  if (!cached) {
    return null;
  }

  try {
    const data = JSON.parse(cached) as Partial<T>;

    // Ensure required fields exist (handles schema migration from older cache)
    if (!data.version || !data.tag) {
      return null;
    }

    // Provide defaults for new fields that may be missing from old cache
    const result = {
      ...data,
      version: data.version,
      tag: data.tag,
      releaseUrl: data.releaseUrl ?? '',
      publishedAt: data.publishedAt ?? '',
      checkedAt: data.checkedAt ?? new Date().toISOString(),
      isPrerelease: data.isPrerelease ?? isPrerelease(data.tag),
      releaseName: data.releaseName ?? null,
      releaseNotes: data.releaseNotes ?? null,
      upgradeWarnings: data.upgradeWarnings ?? [],
    } as T;
    return result;
  } catch {
    return null;
  }
}

export function getCachedLatestVersion(): Promise<LatestVersionData | null> {
  return getCachedVersion<LatestVersionData>(REDIS_KEYS.VERSION_LATEST_UPSTREAM);
}

export function getCachedLatestForkRelease(): Promise<LatestForkReleaseData | null> {
  return getCachedVersion<LatestForkReleaseData>(REDIS_KEYS.VERSION_LATEST_FORK);
}

/**
 * Gracefully shutdown the version check queue and worker
 */
export async function shutdownVersionCheckQueue(): Promise<void> {
  console.log('Shutting down version check queue...');

  if (versionWorker) {
    await versionWorker.close();
    versionWorker = null;
  }

  if (versionQueue) {
    await versionQueue.close();
    versionQueue = null;
  }

  redisClient = null;
  pubSubPublish = null;

  console.log('Version check queue shutdown complete');
}

/**
 * Get queue statistics for the version check queue
 */
export async function getVersionCheckQueueStats(): Promise<{
  waiting: number;
  active: number;
  completed: number;
  failed: number;
  delayed: number;
  schedule: string | null;
} | null> {
  if (!versionQueue) return null;

  const [waiting, active, completed, failed, delayed] = await Promise.all([
    versionQueue.getWaitingCount(),
    versionQueue.getActiveCount(),
    versionQueue.getCompletedCount(),
    versionQueue.getFailedCount(),
    versionQueue.getDelayedCount(),
  ]);

  return {
    waiting,
    active,
    completed,
    failed,
    delayed,
    schedule: `every ${CACHE_TTL.VERSION_CHECK * 1000}ms`,
  };
}
