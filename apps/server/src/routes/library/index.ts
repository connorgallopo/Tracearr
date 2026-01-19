/**
 * Library Statistics Routes
 *
 * Sub-routes for library analytics endpoints (stats, growth, quality, storage, duplicates, stale)
 */

import type { FastifyPluginAsync } from 'fastify';
import { libraryStatsRoute } from './stats.js';
import { libraryGrowthRoute } from './growth.js';
import { libraryQualityRoute } from './quality.js';
import { libraryStorageRoute } from './storage.js';
import { libraryDuplicatesRoute } from './duplicates.js';
import { libraryStaleRoute } from './stale.js';
import { libraryWatchRoute } from './watch.js';
import { libraryRoiRoute } from './roi.js';
import { libraryPatternsRoute } from './patterns.js';
import { libraryCompletionRoute } from './completion.js';

export const libraryStatsRoutes: FastifyPluginAsync = async (app) => {
  // Register all sub-route plugins
  // Each plugin defines its own paths (no additional prefix needed)
  await app.register(libraryStatsRoute);
  await app.register(libraryGrowthRoute);
  await app.register(libraryQualityRoute);
  await app.register(libraryStorageRoute);
  await app.register(libraryDuplicatesRoute);
  await app.register(libraryStaleRoute);
  await app.register(libraryWatchRoute);
  await app.register(libraryRoiRoute);
  await app.register(libraryPatternsRoute);
  await app.register(libraryCompletionRoute);
};

// Re-export utilities for potential use by other modules
export { buildLibraryServerFilter, buildLibraryCacheKey } from './utils.js';
