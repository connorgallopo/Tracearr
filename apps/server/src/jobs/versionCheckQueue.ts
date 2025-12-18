/**
 * Version Check Queue - BullMQ-based periodic version checking
 *
 * Checks GitHub releases for new versions and caches the result.
 * Broadcasts update availability to connected clients via pub/sub.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import type { Redis } from 'ioredis';
import { REDIS_KEYS, CACHE_TTL, WS_EVENTS } from '@tracearr/shared';

// Queue name
const QUEUE_NAME = 'version-check';

// GitHub API configuration
const GITHUB_API_URL = 'https://api.github.com/repos/connorgallopo/Tracearr/releases/latest';
const GITHUB_RELEASES_URL = 'https://github.com/connorgallopo/Tracearr/releases';

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

  connectionOptions = { url: redisUrl };
  redisClient = redis;
  pubSubPublish = publishFn;

  // Create the version check queue
  versionQueue = new Queue<VersionCheckJobData>(QUEUE_NAME, {
    connection: connectionOptions,
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
      concurrency: 1, // Only one check at a time
    }
  );

  versionWorker.on('error', (error) => {
    console.error('Version check worker error:', error);
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

  // Remove any existing job schedulers (repeatable jobs)
  const schedulers = await versionQueue.getJobSchedulers();
  for (const scheduler of schedulers) {
    if (scheduler.id) {
      await versionQueue.removeJobScheduler(scheduler.id);
    }
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

  // Run an immediate check on startup
  await versionQueue.add('startup-check', { type: 'check' }, { jobId: `startup-${Date.now()}` });

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

/**
 * Process a version check job
 */
async function processVersionCheck(job: Job<VersionCheckJobData>): Promise<void> {
  if (!redisClient) {
    throw new Error('Redis client not available');
  }

  console.log(`Processing version check (job ${job.id}, force=${job.data.force ?? false})`);

  try {
    // Fetch latest release from GitHub
    const response = await fetch(GITHUB_API_URL, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Tracearr-Version-Check',
      },
    });

    if (!response.ok) {
      // Handle rate limiting gracefully
      if (response.status === 403 || response.status === 429) {
        const retryAfter = response.headers.get('retry-after');
        console.warn(`GitHub rate limit hit, retry after ${retryAfter ?? 'unknown'}s`);
        throw new Error('GitHub rate limit exceeded');
      }

      // 404 means no releases yet - not an error
      if (response.status === 404) {
        console.log('No releases found on GitHub');
        return;
      }

      throw new Error(`GitHub API returned ${response.status}`);
    }

    const release = (await response.json()) as {
      tag_name: string;
      html_url: string;
      published_at: string;
      name: string;
    };

    // Parse version from tag (remove 'v' prefix if present)
    const version = release.tag_name.replace(/^v/, '');

    const latestData: LatestVersionData = {
      version,
      tag: release.tag_name,
      releaseUrl: release.html_url || `${GITHUB_RELEASES_URL}/tag/${release.tag_name}`,
      publishedAt: release.published_at,
      checkedAt: new Date().toISOString(),
    };

    // Cache in Redis
    await redisClient.set(
      REDIS_KEYS.VERSION_LATEST,
      JSON.stringify(latestData),
      'EX',
      CACHE_TTL.VERSION_CHECK
    );

    console.log(`Latest version cached: ${version} (tag: ${release.tag_name})`);

    // Get current version to check if update is available
    const currentVersion = getCurrentVersion();
    const updateAvailable = isNewerVersion(version, currentVersion);

    if (updateAvailable && pubSubPublish) {
      // Broadcast update availability to connected clients
      await pubSubPublish(WS_EVENTS.VERSION_UPDATE, {
        current: currentVersion,
        latest: version,
        releaseUrl: latestData.releaseUrl,
      });
      console.log(`Update available: ${currentVersion} -> ${version}`);
    }
  } catch (error) {
    console.error('Version check failed:', error);
    throw error;
  }
}

/**
 * Get the current running version from environment
 */
export function getCurrentVersion(): string {
  return process.env.APP_VERSION ?? '0.0.0';
}

/**
 * Get the current Docker tag from environment
 */
export function getCurrentTag(): string | null {
  return process.env.APP_TAG ?? null;
}

/**
 * Get the current git commit from environment
 */
export function getCurrentCommit(): string | null {
  return process.env.APP_COMMIT ?? null;
}

/**
 * Get the build date from environment
 */
export function getBuildDate(): string | null {
  return process.env.APP_BUILD_DATE ?? null;
}

/**
 * Get cached latest version from Redis
 */
export async function getCachedLatestVersion(): Promise<LatestVersionData | null> {
  if (!redisClient) {
    return null;
  }

  const cached = await redisClient.get(REDIS_KEYS.VERSION_LATEST);
  if (!cached) {
    return null;
  }

  try {
    return JSON.parse(cached) as LatestVersionData;
  } catch {
    return null;
  }
}

/**
 * Compare two semantic versions
 * Returns true if latest > current
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parseVersion = (v: string): [number, number, number] => {
    const parts = v
      .replace(/^v/, '')
      .split('.')
      .map((n) => parseInt(n, 10) || 0);
    return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
  };

  const [latestMajor, latestMinor, latestPatch] = parseVersion(latest);
  const [currentMajor, currentMinor, currentPatch] = parseVersion(current);

  if (latestMajor > currentMajor) return true;
  if (latestMajor < currentMajor) return false;
  if (latestMinor > currentMinor) return true;
  if (latestMinor < currentMinor) return false;
  if (latestPatch > currentPatch) return true;

  return false;
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
