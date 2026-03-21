/**
 * Image routes unit tests
 *
 * Tests the API endpoints for image proxy functionality:
 * - GET /images/proxy - Proxy an image from a media server
 * - GET /images/avatar - Get a user avatar
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';

// Mock image proxy service
vi.mock('../../services/imageProxy.js', () => ({
  proxyImage: vi.fn(),
}));

// Import mocked service and routes
import { proxyImage } from '../../services/imageProxy.js';
import { imageRoutes } from '../images.js';

/**
 * Build a test Fastify instance
 * Note: Image routes are public (no auth required)
 */
async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // Register sensible for HTTP error helpers
  await app.register(sensible);
  await app.register(helmet, {
    contentSecurityPolicy: false,
    crossOriginOpenerPolicy: false,
    crossOriginEmbedderPolicy: false,
    originAgentCluster: false,
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
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(response.rawPayload).toEqual(mockImageData);

      // Verify service was called with defaults
      expect(mockProxyImage).toHaveBeenCalledWith({
        serverId: validServerId,
        imagePath: '/library/metadata/123/thumb/456',
        width: 300,
        height: 450,
        fallback: 'poster',
      });
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
  });

  describe('GET /images/avatar', () => {
    it('returns avatar from media server when server and url provided', async () => {
      app = await buildTestApp();

      const mockImageData = Buffer.from('avatar-data');
      mockProxyImage.mockResolvedValue({
        data: mockImageData,
        contentType: 'image/png',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/avatar',
        query: {
          server: validServerId,
          url: '/users/123/avatar',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toBe('image/png');
      expect(response.headers['cache-control']).toContain('public');
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(response.rawPayload).toEqual(mockImageData);

      expect(mockProxyImage).toHaveBeenCalledWith({
        serverId: validServerId,
        imagePath: '/users/123/avatar',
        width: 100,
        height: 100,
        fallback: 'avatar',
      });
    });

    it('accepts custom size parameter', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('avatar'),
        contentType: 'image/jpeg',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/avatar',
        query: {
          server: validServerId,
          url: '/avatar',
          size: '200',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(mockProxyImage).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 200,
          height: 200,
        })
      );
    });

    it('returns fallback avatar when no server provided', async () => {
      app = await buildTestApp();

      const mockFallbackData = Buffer.from('fallback-avatar');
      mockProxyImage.mockResolvedValue({
        data: mockFallbackData,
        contentType: 'image/svg+xml',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/avatar',
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toContain('public');
      expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');

      expect(mockProxyImage).toHaveBeenCalledWith({
        serverId: 'fallback',
        imagePath: 'fallback',
        width: 100,
        height: 100,
        fallback: 'avatar',
      });
    });

    it('returns fallback avatar when server provided but no url', async () => {
      app = await buildTestApp();

      const mockFallbackData = Buffer.from('fallback-avatar');
      mockProxyImage.mockResolvedValue({
        data: mockFallbackData,
        contentType: 'image/svg+xml',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/avatar',
        query: {
          server: validServerId,
        },
      });

      expect(response.statusCode).toBe(200);

      // Without URL, should use fallback
      expect(mockProxyImage).toHaveBeenCalledWith({
        serverId: 'fallback',
        imagePath: 'fallback',
        width: 100,
        height: 100,
        fallback: 'avatar',
      });
    });

    it('sets longer cache for fallback avatars', async () => {
      app = await buildTestApp();

      mockProxyImage.mockResolvedValue({
        data: Buffer.from('fallback'),
        contentType: 'image/svg+xml',
        cached: false,
      });

      const response = await app.inject({
        method: 'GET',
        url: '/images/avatar',
      });

      expect(response.statusCode).toBe(200);
      // Fallback should have longer cache (86400 seconds = 1 day)
      expect(response.headers['cache-control']).toContain('max-age=86400');
    });
  });
});
