/**
 * Image proxy routes
 *
 * Provides a proxy endpoint for fetching images from Plex/Jellyfin servers.
 * This solves CORS issues and allows resizing/caching of images.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { proxyImage, type FallbackType } from '../services/imageProxy.js';

// Static Tracearr logo paths (check for custom logo first, then use default)
const CUSTOM_LOGO_PATH = join(process.cwd(), 'data', 'logo.png');
const ASSETS_LOGO_PATH = join(process.cwd(), 'assets', 'logo.png');

// Fallback SVG logo if no PNG exists
const FALLBACK_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
  <defs>
    <linearGradient id="logoGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#22D3EE"/>
      <stop offset="100%" style="stop-color:#0EA5E9"/>
    </linearGradient>
  </defs>
  <rect width="128" height="128" rx="24" fill="#1a1a2e"/>
  <g transform="translate(24, 24)">
    <rect x="10" y="10" width="60" height="60" rx="8" fill="url(#logoGrad)" opacity="0.9"/>
    <polygon points="35,25 55,40 35,55" fill="#1a1a2e"/>
  </g>
  <text x="64" y="105" text-anchor="middle" fill="#22D3EE" font-family="system-ui" font-weight="bold" font-size="14">Tracearr</text>
</svg>`;

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

    // Allow public proxy images to be embedded by third-party dashboards.
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
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

      reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
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

    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cache-Control', 'public, max-age=86400');
    reply.header('Content-Type', result.contentType);
    return reply.send(result.data);
  });

  /**
   * GET /images/logo - Get the Tracearr logo
   *
   * Returns a static Tracearr logo for use in push notifications (server up/down).
   * Checks for custom logo at data/logo.png, then assets/logo.png, then SVG fallback.
   *
   * No authentication required - logo is public.
   */
  app.get('/logo', async (_request, reply) => {
    // Check for custom logo first (allows user customization)
    if (existsSync(CUSTOM_LOGO_PATH)) {
      const logo = readFileSync(CUSTOM_LOGO_PATH);
      reply.header('Cache-Control', 'public, max-age=604800'); // 1 week
      reply.header('Content-Type', 'image/png');
      return reply.send(logo);
    }

    // Check for bundled logo in assets
    if (existsSync(ASSETS_LOGO_PATH)) {
      const logo = readFileSync(ASSETS_LOGO_PATH);
      reply.header('Cache-Control', 'public, max-age=604800'); // 1 week
      reply.header('Content-Type', 'image/png');
      return reply.send(logo);
    }

    // Return fallback SVG logo
    reply.header('Cache-Control', 'public, max-age=604800'); // 1 week
    reply.header('Content-Type', 'image/svg+xml');
    return reply.send(Buffer.from(FALLBACK_LOGO_SVG));
  });
};
