/**
 * User Routes Module
 *
 * Orchestrates all user-related routes and provides unified export.
 *
 * Routes:
 * - GET / - List all users with pagination
 * - GET /:id - Get user details
 * - PATCH /:id - Update user
 * - GET /:id/full - Get complete user details (aggregate endpoint)
 * - GET /:id/sessions - Get user's session history
 * - GET /:id/locations - Get user's unique locations
 * - GET /:id/devices - Get user's unique devices
 * - GET /:id/terminations - Get user's termination history
 * - GET /:id/requests - Get user's Seerr request history
 * - POST /:id/merge - Merge the source identity :id into another identity
 * - GET /merge-suggestions - Possible duplicate identities across servers
 */

import type { FastifyPluginAsync } from 'fastify';
import { listRoutes } from './list.js';
import { fullRoutes } from './full.js';
import { sessionsRoutes } from './sessions.js';
import { locationsRoutes } from './locations.js';
import { devicesRoutes } from './devices.js';
import { terminationsRoutes } from './terminations.js';
import { requestsRoutes } from './requests.js';
import { mergeRoutes } from './merge.js';

export const userRoutes: FastifyPluginAsync = async (app) => {
  // Register all sub-route plugins
  // Each plugin defines its own paths (no additional prefix needed)
  await app.register(listRoutes);
  await app.register(fullRoutes);
  await app.register(sessionsRoutes);
  await app.register(locationsRoutes);
  await app.register(devicesRoutes);
  await app.register(terminationsRoutes);
  await app.register(requestsRoutes);
  await app.register(mergeRoutes);
};
