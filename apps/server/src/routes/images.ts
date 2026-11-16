/**
 * Image proxy routes
 *
 * Provides a proxy endpoint for fetching images from Plex/Jellyfin servers.
 * This solves CORS issues and allows resizing/caching of images.
 */

import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { POSTER_IMAGE_SIZE, SQUARE_POSTER_SIZE } from '@tracearr/shared';
import {
  IMAGE_SIZES,
  posterVersionFor,
  proxyAccountPicture,
  proxyImage,
} from '../services/imageProxy.js';
import { readLogoPng } from '../services/notifications/emailLogo.js';
import { getUserById } from '../services/userService.js';

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

const proxyQuerySchema = z
  .object({
    server: z.uuid({ error: 'Invalid server ID' }),
    url: z.string().min(1, 'Image URL is required'),
    width: z.coerce.number().int().min(10).max(2000).optional().default(300),
    height: z.coerce.number().int().min(10).max(2000).optional().default(450),
    fallback: z.enum(['poster', 'avatar', 'art']).optional().default('poster'),
    // Cache-busting fingerprint (posterVersionFor output). Presence marks the
    // response cache as long-lived/immutable, so only the poster sizes are allowed.
    v: z
      .string()
      .regex(/^[0-9a-f]{8}$/i)
      .optional(),
    // Web grid only: allow the LQIP placeholder race. Absent for every other consumer.
    lqip: z.enum(['1']).optional(),
  })
  .refine(
    (data) =>
      data.v === undefined ||
      [POSTER_IMAGE_SIZE, SQUARE_POSTER_SIZE].some(
        (size) => data.width === size.width && data.height === size.height
      ),
    {
      message: `Versioned requests must be ${POSTER_IMAGE_SIZE.width}x${POSTER_IMAGE_SIZE.height} or ${SQUARE_POSTER_SIZE.width}x${SQUARE_POSTER_SIZE.height}`,
      path: ['width'],
    }
  )
  // Fails closed: a v that doesn't match the path's own fingerprint never earns
  // immutable caching, so this can't be used to mint arbitrary cache entries.
  .refine((data) => data.v === undefined || data.v === posterVersionFor(data.url), {
    message: 'Version fingerprint does not match the image path',
    path: ['v'],
  });

export const imageRoutes: FastifyPluginAsync = async (app) => {
  // Sandboxed previews (opaque origin) and hosted-mode mail clients both need
  // these public images to bypass helmet's default same-origin CORP.
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
  });

  /**
   * GET /images/proxy - Proxy an image from a media server
   *
   * Note: No authentication required - images are public once you have
   * a valid server ID. This allows <img> tags to work without auth headers.
   * Server ID is validated in proxyImage service.
   *
   * Query params:
   * - server: UUID of the server to fetch from, or of the request service whose
   *   poster a request shows while its title is in no library
   * - url: The image path (e.g., /library/metadata/123/thumb/456)
   * - width: Resize width (default 300)
   * - height: Resize height (default 450)
   * - fallback: Placeholder type if image fails (poster, avatar, art)
   * - v: Optional cache-busting fingerprint; when present the response is
   *   cached as long-lived/immutable instead of the default short cache
   * - lqip=1: Web grid only; race the miss against the LQIP placeholder
   */
  app.get('/proxy', async (request, reply) => {
    const parseResult = proxyQuerySchema.safeParse(request.query);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid query parameters',
        details: z.treeifyError(parseResult.error),
      });
    }

    const { server, url, width, height, fallback, v, lqip } = parseResult.data;

    const result = await proxyImage({
      serverId: server,
      imagePath: url,
      width,
      height,
      fallback: fallback,
      version: v,
      lqip: lqip === '1',
    });

    // Set cache headers
    if (result.cached) {
      reply.header('X-Cache', 'HIT');
    } else {
      reply.header('X-Cache', 'MISS');
    }

    // A versioned request is immutable (the fingerprint changes when the
    // poster changes); the pipeline can still override with a short-lived
    // header for the degraded LQIP placeholder response.
    const cacheControl =
      result.cacheControl ??
      (v
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600, stale-while-revalidate=86400');
    reply.header('Cache-Control', cacheControl);
    reply.header('Content-Type', result.contentType);

    return reply.send(result.data);
  });

  /**
   * GET /images/account - The signed-in person's own picture when it is an absolute address, such
   * as their OIDC provider's. 404 when there is none or it cannot be fetched, so the page shows
   * initials. Private, since the picture follows the session.
   */
  app.get('/account', { preHandler: [app.authenticate] }, async (request, reply) => {
    const picture = (await getUserById(request.user.userId))?.thumbnail;
    const result =
      picture && URL.canParse(picture)
        ? await proxyAccountPicture(picture, IMAGE_SIZES.apiAvatar.width)
        : null;
    if (!result) return reply.status(404).send();
    reply.header('Cache-Control', 'private, no-store');
    reply.header('Content-Type', result.contentType);
    return reply.send(result.data);
  });

  /**
   * GET /images/logo - Get the Tracearr logo
   *
   * Returns a static Tracearr logo for use in push notifications (server up/down).
   * Checks for the owner's data/logo.png, then the bundled assets/logo.png, then the SVG fallback.
   *
   * No authentication required - logo is public.
   */
  app.get('/logo', async (_request, reply) => {
    const png = readLogoPng();
    reply.header('Cache-Control', 'public, max-age=604800');
    if (png) {
      reply.header('Content-Type', 'image/png');
      return reply.send(png);
    }
    reply.header('Content-Type', 'image/svg+xml');
    return reply.send(Buffer.from(FALLBACK_LOGO_SVG));
  });
};
