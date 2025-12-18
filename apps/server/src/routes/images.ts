/**
 * Image proxy routes
 *
 * Provides a proxy endpoint for fetching images from Plex/Jellyfin servers.
 * This solves CORS issues and allows resizing/caching of images.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { proxyImage, type FallbackType } from '../services/imageProxy.js';

const proxyQuerySchema = z.object({
  server: z.uuid({ error: 'Invalid server ID' }),
  url: z.string().min(1, 'Image URL is required'),
  width: z.coerce.number().int().min(10).max(2000).optional().default(300),
  height: z.coerce.number().int().min(10).max(2000).optional().default(450),
  fallback: z.enum(['poster', 'avatar', 'art']).optional().default('poster'),
});

export const imageRoutes: FastifyPluginAsync = async (app) => {
  /**
   * GET /images/proxy - Proxy an image from a media server
   *
   * Note: No authentication required - images are public once you have
   * a valid server ID. This allows <img> tags to work without auth headers.
   * Server ID is validated in proxyImage service.
   *
   * Query params:
   * - server: UUID of the server to fetch from
   * - url: The image path (e.g., /library/metadata/123/thumb/456)
   * - width: Resize width (default 300)
   * - height: Resize height (default 450)
   * - fallback: Placeholder type if image fails (poster, avatar, art)
   */
  app.get('/proxy', async (request, reply) => {
    const parseResult = proxyQuerySchema.safeParse(request.query);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid query parameters',
        details: z.treeifyError(parseResult.error),
      });
    }

    const { server, url, width, height, fallback } = parseResult.data;

    const result = await proxyImage({
      serverId: server,
      imagePath: url,
      width,
      height,
      fallback: fallback as FallbackType,
    });

    // Set cache headers
    if (result.cached) {
      reply.header('X-Cache', 'HIT');
    } else {
      reply.header('X-Cache', 'MISS');
    }

    // Cache for 1 hour in browser, allow CDN caching
    reply.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    reply.header('Content-Type', result.contentType);

    return reply.send(result.data);
  });

  /**
   * GET /images/avatar - Get a user avatar (with gravatar fallback)
   *
   * Note: No authentication required for same reason as /proxy
   *
   * Query params:
   * - server: UUID of the server (optional if using gravatar)
   * - url: The avatar path from server (optional)
   * - email: Email for gravatar fallback (optional)
   * - size: Avatar size (default 100)
   */
  app.get('/avatar', async (request, reply) => {
    const query = request.query as Record<string, string | undefined>;
    const server = query.server;
    const url = query.url;
    const size = parseInt(query.size ?? '100', 10);

    // If we have server URL, try to fetch from media server
    if (server && url) {
      const result = await proxyImage({
        serverId: server,
        imagePath: url,
        width: size,
        height: size,
        fallback: 'avatar',
      });

      reply.header('Cache-Control', 'public, max-age=3600');
      reply.header('Content-Type', result.contentType);
      return reply.send(result.data);
    }

    // Return fallback avatar
    const result = await proxyImage({
      serverId: 'fallback',
      imagePath: 'fallback',
      width: size,
      height: size,
      fallback: 'avatar',
    });

    reply.header('Cache-Control', 'public, max-age=86400');
    reply.header('Content-Type', result.contentType);
    return reply.send(result.data);
  });
};
