/**
 * Version API Routes
 *
 * Provides version information and update status.
 */

import type { FastifyPluginAsync } from 'fastify';
import { isNewerVersion, isPrerelease, type VersionInfo } from '@tracearr/shared';
import {
  getCurrentVersion,
  getCurrentTag,
  getCurrentCommit,
  getBuildDate,
  getBuildInfo,
  getCachedLatestVersion,
  getCachedLatestForkRelease,
  compareForkVersions,
  forceVersionCheck,
} from '../jobs/versionCheckQueue.js';

export const versionRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /version
   * Get current version info and update status
   * Public endpoint - no auth required (useful for health checks)
   */
  app.get<{
    Reply: VersionInfo;
  }>('/', async () => {
    const currentVersion = getCurrentVersion();
    const currentTag = getCurrentTag();
    const currentCommit = getCurrentCommit();
    const buildDate = getBuildDate();
    const buildInfo = getBuildInfo();

    const [upstreamData, forkData] = await Promise.all([
      getCachedLatestVersion(),
      getCachedLatestForkRelease(),
    ]);

    const forkUpdateAvailable = !!(
      forkData &&
      buildInfo.forkVersion &&
      compareForkVersions(forkData.forkVersion, buildInfo.forkVersion) > 0
    );
    const upstreamUpdateAvailable =
      !!upstreamData && isNewerVersion(upstreamData.version, currentVersion);
    const latestFork = forkData
      ? {
          version: forkData.forkVersion,
          upstreamVersion: forkData.upstreamVersion,
          forkRevision: forkData.forkRevision,
          forkVersion: forkData.forkVersion,
          tag: forkData.tag,
          releaseUrl: forkData.releaseUrl,
          publishedAt: forkData.publishedAt,
          isPrerelease: forkData.isPrerelease,
          releaseName: forkData.releaseName,
          releaseNotes: forkData.releaseNotes,
          upgradeWarnings: forkData.upgradeWarnings.filter((w) =>
            isNewerVersion(w.version, currentVersion)
          ),
        }
      : null;
    const latestUpstream = upstreamData
      ? {
          version: upstreamData.version,
          tag: upstreamData.tag,
          releaseUrl: upstreamData.releaseUrl,
          publishedAt: upstreamData.publishedAt,
          isPrerelease: upstreamData.isPrerelease,
          releaseName: upstreamData.releaseName,
          releaseNotes: upstreamData.releaseNotes,
          upgradeWarnings: upstreamData.upgradeWarnings.filter((w) =>
            isNewerVersion(w.version, currentVersion)
          ),
        }
      : null;
    let recommended: VersionInfo['recommended'];
    if (forkUpdateAvailable && latestFork) {
      recommended = { kind: 'fork-update', target: latestFork };
    } else if (upstreamUpdateAvailable && latestUpstream) {
      recommended = { kind: 'upstream-ahead', target: latestUpstream };
    } else {
      recommended = { kind: 'none' };
    }

    return {
      current: {
        version: currentVersion,
        upstreamVersion: buildInfo.upstreamVersion,
        forkRevision: buildInfo.forkRevision,
        forkVersion: buildInfo.forkVersion,
        forkReleaseTag: buildInfo.forkReleaseTag,
        forkRepo: buildInfo.forkRepo,
        imageRepo: buildInfo.imageRepo,
        tag: currentTag,
        commit: currentCommit,
        buildDate,
        isPrerelease: isPrerelease(currentVersion),
      },
      fork: {
        latest: latestFork,
        updateAvailable: forkUpdateAvailable,
      },
      upstream: {
        latest: latestUpstream,
        updateAvailable: upstreamUpdateAvailable,
      },
      recommended,
      lastChecked:
        [forkData?.checkedAt, upstreamData?.checkedAt].filter(Boolean).sort().at(-1) ?? null,
    };
  });

  /**
   * POST /version/check
   * Force an immediate version check (admin only)
   */
  app.post('/check', {
    preHandler: [app.authenticate],
    handler: async (request, reply) => {
      // Require admin role
      if (request.user.role !== 'owner' && request.user.role !== 'admin') {
        return reply.forbidden('Admin access required');
      }

      await forceVersionCheck();

      return { message: 'Version check queued' };
    },
  });
};
