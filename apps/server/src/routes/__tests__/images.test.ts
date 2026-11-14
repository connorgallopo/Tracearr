/**
 * Image routes unit tests
 *
 * Tests the API endpoints for image proxy functionality:
 * - GET /images/proxy - Proxy an image from a media server
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';

// Mock image proxy service. posterVersionFor is fixed so tests control which
// requests are a "matching" v vs a mismatch without depending on the real hash.
vi.mock('../../services/imageProxy.js', () => ({
  proxyImage: vi.fn(),
  proxyAccountPicture: vi.fn(),
  posterVersionFor: vi.fn(() => 'abcd1234'),
  IMAGE_SIZES: { apiAvatar: { width: 100, height: 100 } },
}));

vi.mock('../../services/userService.js', () => ({ getUserById: vi.fn() }));

const mockReadLogoPng = vi.fn();
vi.mock('../../services/notifications/emailLogo.js', () => ({
  readLogoPng: () => mockReadLogoPng() as unknown,
}));

// Import mocked service and routes
import { proxyAccountPicture, proxyImage } from '../../services/imageProxy.js';
import { getUserById } from '../../services/userService.js';
import { imageRoutes } from '../images.js';

/**
 * Build a test Fastify instance
 * Note: Image routes are public (no auth required)
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers
  await app.register(sensible);
  app.decorate('authenticate', async (request: { user: unknown }) => {
    request.user = { userId: 'user-1' };
  });

  // Register routes
  await app.register(imageRoutes, { prefix: '/images' });

  return app;
}

describe('Image Routes', () => {
  let app: FastifyInstance;
  const mockProxyImage = vi.mocked(proxyImage);
  const validServerId = randomUUID();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    if (app) {
      await app.close();
    }
  });

  describe('GET /images/proxy', () => {
    it('returns proxied image with correct headers', async () => {
      app = await buildTestApp();

      const mockImageData = Buffer.from('fake-image-data');
      mockProxyImage.mockResolvedValue({
        data: mockImageData,
        contentType: 'image/jpeg',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/library/metadata/123/thumb/456',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/jpeg');
      expect(response.headers['x-cache']).toBe('MISS');
      expect(response.headers['cache-control']).toContain('public');
      expect(response.rawPayload).toEqual(mockImageData);

      // Verify service was called with defaults
      expect(mockProxyImage).toHaveBeenCalledWith({
        serverId: validServerId,
        imagePath: '/library/metadata/123/thumb/456',
        width: 300,
        height: 450,
        fallback: 'poster',
        version: undefined,
        lqip: false,
      });
    });

    it('sets a cross-origin resource policy so sandboxed previews and mail clients can load it', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('fake-image-data'),
        contentType: 'image/jpeg',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/library/metadata/123/thumb/456',
        },
      });

      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    });

    it('returns cache HIT header when image is cached', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('cached-image'),
        contentType: 'image/png',
        cached: true,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/some/image/path',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['x-cache']).toBe('HIT');
    });

    it('accepts custom width and height', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('image'),
        contentType: 'image/webp',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          width: '500',
          height: '750',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockProxyImage).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 500,
          height: 750,
        })
      );
    });

    it('accepts avatar fallback type', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('image'),
        contentType: 'image/png',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          fallback: 'avatar',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockProxyImage).toHaveBeenCalledWith(
        expect.objectContaining({
          fallback: 'avatar',
        })
      );
    });

    it('accepts art fallback type', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('image'),
        contentType: 'image/png',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          fallback: 'art',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockProxyImage).toHaveBeenCalledWith(
        expect.objectContaining({
          fallback: 'art',
        })
      );
    });

    it('rejects missing server ID', async () => {
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          url: '/some/path',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('Invalid query parameters');
    });

    it('rejects invalid server ID format', async () => {
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: 'not-a-uuid',
          url: '/some/path',
        },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error).toBe('Invalid query parameters');
    });

    it('rejects missing URL', async () => {
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects width below minimum', async () => {
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          width: '5',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects width above maximum', async () => {
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          width: '3000',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects invalid fallback type', async () => {
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          fallback: 'invalid',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('sets an immutable long-lived Cache-Control when v is present at the poster size', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('image'),
        contentType: 'image/webp',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          width: '360',
          height: '540',
          v: 'abcd1234',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(mockProxyImage).toHaveBeenCalledWith(
        expect.objectContaining({ width: 360, height: 540, version: 'abcd1234' })
      );
    });

    it('rejects v with a width outside the one allowed poster size', async () => {
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          width: '240',
          height: '360',
          v: 'abcd1234',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('lets a degraded LQIP result override the Cache-Control header', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('lqip'),
        contentType: 'image/webp',
        cached: false,
        cacheControl: 'public, max-age=60',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          width: '360',
          height: '540',
          v: 'abcd1234',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('public, max-age=60');
    });

    it('serves the fallback with a short, non-immutable Cache-Control on a versioned request when upstream errors', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('<svg>fallback</svg>'),
        contentType: 'image/svg+xml',
        cached: false,
        cacheControl: 'public, max-age=15',
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          width: '360',
          height: '540',
          v: 'abcd1234',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/svg+xml');
      expect(response.headers['cache-control']).toBe('public, max-age=15');
      expect(response.headers['cache-control']).not.toContain('immutable');
    });

    it('rejects a v that does not match the fingerprint for the given url', async () => {
      app = await buildTestApp();

      const response = await app.inject({
        method: 'GET',
        url: '/images/proxy',
        query: {
          server: validServerId,
          url: '/path',
          width: '360',
          height: '540',
          v: 'deadbeef',
        },
      });

      expect(response.statusCode).toBe(400);
      expect(mockProxyImage).not.toHaveBeenCalled();
    });

    it('takes a versioned request only at the poster or the square art size', async () => {
      app = await buildTestApp();
      mockProxyImage.mockResolvedValue({
        data: Buffer.from('x'),
        contentType: 'image/webp',
        cached: true,
      });
      const versioned = (height: string) =>
        app.inject({
          method: 'GET',
          url: '/images/proxy',
          query: { server: validServerId, url: '/path', width: '360', height, v: 'abcd1234' },
        });

      expect((await versioned('500')).statusCode).toBe(400);
      expect(mockProxyImage).not.toHaveBeenCalled();

      const square = await versioned('360');
      expect(square.statusCode).toBe(200);
      expect(square.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(mockProxyImage).toHaveBeenLastCalledWith(
        expect.objectContaining({ width: 360, height: 360, version: 'abcd1234' })
      );
    });

    it('passes lqip through only when the query says 1', async () => {
      app = await buildTestApp();
      mockProxyImage.mockResolvedValue({
        data: Buffer.from('x'),
        contentType: 'image/webp',
        cached: true,
      });
      await app.inject({
        method: 'GET',
        url: `/images/proxy?server=${validServerId}&url=/p&width=360&height=540&lqip=1`,
      });
      expect(mockProxyImage).toHaveBeenLastCalledWith(expect.objectContaining({ lqip: true }));
      await app.inject({
        method: 'GET',
        url: `/images/proxy?server=${validServerId}&url=/p&width=360&height=540`,
      });
      expect(mockProxyImage).toHaveBeenLastCalledWith(expect.objectContaining({ lqip: false }));
    });
  });

  describe('GET /images/logo', () => {
    it('serves the resolved PNG and falls back to the SVG when there is none', async () => {
      app = await buildTestApp();
      mockReadLogoPng.mockReturnValue(Buffer.from('png-bytes'));
      const png = await app.inject({ method: 'GET', url: '/images/logo' });
      expect(png.statusCode).toBe(200);
      expect(png.headers['content-type']).toBe('image/png');
      expect(png.rawPayload).toEqual(Buffer.from('png-bytes'));

      mockReadLogoPng.mockReturnValue(null);
      const svg = await app.inject({ method: 'GET', url: '/images/logo' });
      expect(svg.headers['content-type']).toBe('image/svg+xml');
      expect(svg.payload).toContain('<svg');
    });
  });

  describe('GET /images/account', () => {
    it("serves the signed-in person's own picture from its address, privately", async () => {
      app = await buildTestApp();
      vi.mocked(getUserById).mockResolvedValue({
        thumbnail: 'https://idp.example.com/avatars/alice.png',
      } as never);
      vi.mocked(proxyAccountPicture).mockResolvedValue({
        data: Buffer.from('webp-bytes'),
        contentType: 'image/webp',
        cached: false,
      });

      const res = await app.inject({ method: 'GET', url: '/images/account' });

      expect(proxyAccountPicture).toHaveBeenCalledWith(
        'https://idp.example.com/avatars/alice.png',
        100
      );
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('private, no-store');
      expect(res.rawPayload).toEqual(Buffer.from('webp-bytes'));
    });

    it.each([
      ['no picture', null],
      ['a server path', '/api/v1/profiles/avatars/astronaut.png'],
    ])('answers 404 for %s', async (_kind, thumbnail) => {
      app = await buildTestApp();
      vi.mocked(getUserById).mockResolvedValue({ thumbnail } as never);

      const res = await app.inject({ method: 'GET', url: '/images/account' });

      expect(res.statusCode).toBe(404);
      expect(proxyAccountPicture).not.toHaveBeenCalled();
    });
  });
});
