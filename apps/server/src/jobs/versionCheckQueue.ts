/**
 * Version Check Queue - BullMQ-based periodic version checking
 *
 * Checks GitHub releases for new versions and caches the result.
 * Broadcasts update availability to connected clients via pub/sub.
 */

import { Queue, Worker, type Job, type ConnectionOptions } from 'bullmq';
import { getRedisPrefix } from '@tracearr/shared';
import type { Redis } from 'ioredis';
import { REDIS_KEYS, CACHE_TTL, WS_EVENTS } from '@tracearr/shared';

// Queue name
const QUEUE_NAME = 'version-check';

// GitHub API configuration
const GITHUB_API_LATEST_URL = 'https://api.github.com/repos/connorgallopo/Tracearr/releases/latest';
const GITHUB_API_ALL_RELEASES_URL = 'https://api.github.com/repos/connorgallopo/Tracearr/releases';
const GITHUB_RELEASES_URL = 'https://github.com/connorgallopo/Tracearr/releases';

// Prerelease identifier patterns (beta, alpha, rc, etc.)
const PRERELEASE_PATTERN = /-(alpha|beta|rc|next|dev|canary)\.?\d*$/i;

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
  const bullPrefix = `${getRedisPrefix()}bull`;

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

  const bullPrefix = `${getRedisPrefix()}bull`;

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

// GitHub release structure from API
export interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  name: string;
  body: string | null;
  prerelease: boolean;
  draft: boolean;
}

/**
 * Fetch releases from GitHub API
 */
async function fetchGitHubReleases(url: string): Promise<GitHubRelease[] | GitHubRelease | null> {
  const response = await fetch(url, {
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
      return null;
    }

    throw new Error(`GitHub API returned ${response.status}`);
  }

  return response.json() as Promise<GitHubRelease[] | GitHubRelease>;
}

/**
 * Find the best update target for a prerelease user
 *
 * Returns the newest stable release if available, otherwise the newest prerelease.
 * This ensures prerelease users are notified about the latest stable version
 * (e.g., user on 1.4.1-beta.17 sees 1.4.3, not just 1.4.1).
 */
export function findBestUpdateForPrerelease(
  currentVersion: string,
  releases: GitHubRelease[]
): GitHubRelease | null {
  // Filter out drafts and sort by version (newest first)
  const validReleases = releases
    .filter((r) => !r.draft)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));

  // Find the newest stable release
  const newestStable = validReleases.find((r) => !r.prerelease);

  // If there's a stable release newer than current, return it
  if (newestStable && compareVersions(newestStable.tag_name, currentVersion) > 0) {
    return newestStable;
  }

  // Otherwise, find any newer release (including prereleases)
  const newerRelease = validReleases.find((r) => {
    return compareVersions(r.tag_name, currentVersion) > 0;
  });

  return newerRelease ?? null;
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
    const currentVersion = getCurrentVersion();
    const currentIsPrerelease = isPrerelease(currentVersion);

    console.log(`Current version: ${currentVersion} (prerelease: ${currentIsPrerelease})`);

    let targetRelease: GitHubRelease | null = null;

    if (currentIsPrerelease) {
      // For prerelease users, fetch all releases to find the best update
      const releases = await fetchGitHubReleases(`${GITHUB_API_ALL_RELEASES_URL}?per_page=30`);

      if (!releases || !Array.isArray(releases)) {
        console.log('No releases found or invalid response');
        return;
      }

      targetRelease = findBestUpdateForPrerelease(currentVersion, releases);
    } else {
      // For stable users, just check the latest stable release
      const release = await fetchGitHubReleases(GITHUB_API_LATEST_URL);

      if (!release || Array.isArray(release)) {
        console.log('No latest release found');
        return;
      }

      targetRelease = release;
    }

    if (!targetRelease) {
      console.log('No update target found');
      return;
    }

    // Parse version from tag (remove 'v' prefix if present)
    const version = targetRelease.tag_name.replace(/^v/, '');

    const latestData: LatestVersionData = {
      version,
      tag: targetRelease.tag_name,
      releaseUrl: targetRelease.html_url || `${GITHUB_RELEASES_URL}/tag/${targetRelease.tag_name}`,
      publishedAt: targetRelease.published_at,
      checkedAt: new Date().toISOString(),
      isPrerelease: targetRelease.prerelease,
      releaseName: targetRelease.name || null,
      releaseNotes: targetRelease.body || null,
    };

    // Cache in Redis
    await redisClient.set(
      REDIS_KEYS.VERSION_LATEST,
      JSON.stringify(latestData),
      'EX',
      CACHE_TTL.VERSION_CHECK
    );

    console.log(`Latest version cached: ${version} (tag: ${targetRelease.tag_name})`);

    // Check if update is available
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
    const data = JSON.parse(cached) as Partial<LatestVersionData>;

    // Ensure required fields exist (handles schema migration from older cache)
    if (!data.version || !data.tag) {
      return null;
    }

    // Provide defaults for new fields that may be missing from old cache
    return {
      version: data.version,
      tag: data.tag,
      releaseUrl: data.releaseUrl ?? '',
      publishedAt: data.publishedAt ?? '',
      checkedAt: data.checkedAt ?? new Date().toISOString(),
      isPrerelease: data.isPrerelease ?? isPrerelease(data.tag),
      releaseName: data.releaseName ?? null,
      releaseNotes: data.releaseNotes ?? null,
    };
  } catch {
    return null;
  }
}

/**
 * Parsed semantic version with prerelease support
 */
interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null; // e.g., "beta", "alpha", "rc"
  prereleaseNum: number | null; // e.g., 3 for "beta.3"
  isPrerelease: boolean;
}

/**
 * Parse a semantic version string into components
 * Handles: 1.3.9, v1.3.9, 1.3.9-beta.3, v1.4.0-rc.1
 */
export function parseVersion(version: string): ParsedVersion {
  // Remove 'v' prefix
  const v = version.replace(/^v/, '');

  // Match: major.minor.patch(-prerelease.num)?
  const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-([a-zA-Z]+)(?:\.(\d+))?)?$/);

  if (!match) {
    // Fallback for malformed versions
    return {
      major: 0,
      minor: 0,
      patch: 0,
      prerelease: null,
      prereleaseNum: null,
      isPrerelease: false,
    };
  }

  const [, major = '0', minor = '0', patch = '0', prerelease, prereleaseNum] = match;

  return {
    major: parseInt(major, 10),
    minor: parseInt(minor, 10),
    patch: parseInt(patch, 10),
    prerelease: prerelease ?? null,
    prereleaseNum: prereleaseNum ? parseInt(prereleaseNum, 10) : null,
    isPrerelease: !!prerelease,
  };
}

/**
 * Check if a version string represents a prerelease
 */
export function isPrerelease(version: string): boolean {
  return PRERELEASE_PATTERN.test(version.replace(/^v/, ''));
}

/**
 * Get the base version without prerelease suffix
 * e.g., "1.3.9-beta.3" -> "1.3.9"
 */
export function getBaseVersion(version: string): string {
  return version.replace(/^v/, '').replace(/-.*$/, '');
}

/**
 * Compare two semantic versions with full prerelease support
 * Returns: 1 if a > b, -1 if a < b, 0 if equal
 *
 * Ordering rules:
 * - Higher major/minor/patch wins
 * - Stable release > any prerelease of same base version (1.3.9 > 1.3.9-beta.99)
 * - Prerelease ordering: alpha < beta < rc (then by number)
 */
export function compareVersions(a: string, b: string): number {
  const vA = parseVersion(a);
  const vB = parseVersion(b);

  // Compare major.minor.patch
  if (vA.major !== vB.major) return vA.major > vB.major ? 1 : -1;
  if (vA.minor !== vB.minor) return vA.minor > vB.minor ? 1 : -1;
  if (vA.patch !== vB.patch) return vA.patch > vB.patch ? 1 : -1;

  // Same base version - check prerelease status
  if (!vA.isPrerelease && !vB.isPrerelease) return 0; // Both stable
  if (!vA.isPrerelease && vB.isPrerelease) return 1; // a is stable, b is prerelease
  if (vA.isPrerelease && !vB.isPrerelease) return -1; // a is prerelease, b is stable

  // Both are prereleases of same base version
  const prereleaseOrder: Record<string, number> = {
    dev: 0,
    canary: 1,
    alpha: 2,
    beta: 3,
    rc: 4,
    next: 5,
  };

  const orderA = prereleaseOrder[vA.prerelease?.toLowerCase() ?? ''] ?? 3;
  const orderB = prereleaseOrder[vB.prerelease?.toLowerCase() ?? ''] ?? 3;

  if (orderA !== orderB) return orderA > orderB ? 1 : -1;

  // Same prerelease type - compare numbers
  const numA = vA.prereleaseNum ?? 0;
  const numB = vB.prereleaseNum ?? 0;

  if (numA !== numB) return numA > numB ? 1 : -1;

  return 0;
}

/**
 * Compare two semantic versions
 * Returns true if latest > current
 */
export function isNewerVersion(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
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
