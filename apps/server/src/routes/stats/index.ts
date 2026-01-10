import type { FastifyPluginAsync } from 'fastify';
import { dashboardRoutes } from './dashboard.js';
import { playsRoutes } from './plays.js';
import { usersRoutes } from './users.js';
import { contentRoutes } from './content.js';
import { locationsRoutes } from './locations.js';
import { engagementRoutes } from './engagement.js';
import { devicesRoutes } from './devices.js';
import { bandwidthRoutes } from './bandwidth.js';
import { platformsRoutes } from './platforms.js';
import { qualityRoutes } from './quality.js';
import { concurrentRoutes } from './concurrent.js';

export const statsRoutes: FastifyPluginAsync = async (app) => {
  // Register all sub-route plugins
  // Each plugin defines its own paths (no additional prefix needed)
  await app.register(dashboardRoutes);
  await app.register(playsRoutes);
  await app.register(usersRoutes);
  await app.register(contentRoutes);
  await app.register(locationsRoutes);
  await app.register(engagementRoutes);
  await app.register(devicesRoutes);
  await app.register(bandwidthRoutes);
  await app.register(platformsRoutes);
  await app.register(qualityRoutes);
  await app.register(concurrentRoutes);
};

// Re-export utilities for potential use by other modules
export { resolveDateRange, hasAggregates } from './utils.js';
// Deprecated - kept for backwards compatibility
// eslint-disable-next-line @typescript-eslint/no-deprecated
export { getDateRange } from './utils.js';
