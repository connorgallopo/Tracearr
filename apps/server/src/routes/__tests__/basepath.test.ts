/**
 * BASE_PATH support tests
 *
 * Tests the env-var-based BASE_PATH feature:
 * - URL rewriting (strips basePath prefix before routing)
 * - Redirect from root to basePath
 * - <base> tag injection for SPA fallback
 * - Static file serving through basePath
 *
 * Uses a minimal Fastify app that replicates the basePath-relevant config
 * from index.ts. No DB or Redis required.
 */

import { describe, it, expect, afterEach, beforeEach, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

// Temp directory with a fake index.html and static asset
const TEMP_DIR = resolve(tmpdir(), `basepath-test-${Date.now()}`);
const FAKE_INDEX_HTML =
  '<!DOCTYPE html><html><head><title>Test</title></head><body>app</body></html>';
const FAKE_JS = 'console.log("test");';

beforeEach(() => {
  mkdirSync(resolve(TEMP_DIR, 'assets'), { recursive: true });
  writeFileSync(resolve(TEMP_DIR, 'index.html'), FAKE_INDEX_HTML);
  writeFileSync(resolve(TEMP_DIR, 'assets', 'test.js'), FAKE_JS);
});

afterAll(() => {
  rmSync(TEMP_DIR, { recursive: true, force: true });
});

/**
 * Builds a minimal Fastify app that mirrors the basePath behavior from index.ts.
 * basePath is passed as an argument (rather than reading process.env) to keep
 * tests self-contained and avoid env var side effects.
 */
async function buildTestApp(basePath: string): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    rewriteUrl(req) {
      const url = req.url ?? '/';
      if (basePath) {
        if (url.startsWith(`${basePath}/`) || url === basePath) {
          return url.slice(basePath.length) || '/';
        }
      }
      return url;
    },
  });

  // A simple test route to verify URL rewriting
  app.get('/test', async () => ({ ok: true }));

  // Health endpoint — always reachable
  app.get('/health', async () => ({ status: 'ok' }));

  // API-like route to verify prefix stripping
  app.get('/api/v1/settings', async () => ({ settings: true }));

  // Static file serving + SPA fallback (mirrors production setNotFoundHandler)
  await app.register(fastifyStatic, {
    root: TEMP_DIR,
    prefix: '/',
    serve: false,
  });

  const cachedIndexHtml = FAKE_INDEX_HTML;

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url === '/health') {
      return reply.code(404).send({ error: 'Not Found' });
    }

    // Redirect to basePath if original URL isn't under it
    if (basePath) {
      const originalUrl = request.originalUrl;
      if (!originalUrl.startsWith(`${basePath}/`) && originalUrl !== basePath) {
        return reply.redirect(`${basePath}/`);
      }
    }

    const urlPath = request.url.split('?')[0]!;

    // Serve static files (paths with a file extension)
    if (urlPath !== '/' && /\.\w+$/.test(urlPath)) {
      const assetPath = urlPath.slice(1);
      if (existsSync(resolve(TEMP_DIR, assetPath))) {
        return reply.sendFile(assetPath);
      }
      if (assetPath.startsWith('assets/')) {
        return reply.code(404).send();
      }
    }

    // SPA fallback with <base> tag injection
    const baseHref = basePath ? `${basePath}/` : '/';
    const html = cachedIndexHtml.replace('<head>', `<head>\n    <base href="${baseHref}">`);
    reply.header('Cache-Control', 'no-cache');
    return reply.type('text/html').send(html);
  });

  return app;
}

describe('BASE_PATH support', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    if (app) await app.close();
  });

  // ==========================================================================
  // With BASE_PATH=/tracearr
  // ==========================================================================
  describe('with BASE_PATH=/tracearr', () => {
    const BASE_PATH = '/tracearr';

    beforeEach(async () => {
      app = await buildTestApp(BASE_PATH);
    });

    // --- URL rewriting ---

    it('rewrites prefixed URL to strip basePath', async () => {
      const res = await app.inject({ method: 'GET', url: '/tracearr/test' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it('rewrites basePath without trailing slash to /', async () => {
      const res = await app.inject({ method: 'GET', url: '/tracearr' });
      // "/" with no file extension → SPA fallback
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    it('rewrites prefixed API route correctly', async () => {
      const res = await app.inject({ method: 'GET', url: '/tracearr/api/v1/settings' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ settings: true });
    });

    it('rewrites prefixed health endpoint', async () => {
      const res = await app.inject({ method: 'GET', url: '/tracearr/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    });

    it('does not rewrite URLs without basePath prefix', async () => {
      // /test without prefix → rewriteUrl passes through unchanged → route matches /test
      const res = await app.inject({ method: 'GET', url: '/test' });
      // The URL matches the /test route directly (no rewriting needed)
      expect(res.statusCode).toBe(200);
    });

    // --- Redirect ---

    it('redirects / to /tracearr/', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/tracearr/');
    });

    it('does not redirect /tracearr/ (no redirect loop)', async () => {
      const res = await app.inject({ method: 'GET', url: '/tracearr/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    // --- <base> tag injection ---

    it('injects <base href="/tracearr/"> in SPA fallback', async () => {
      const res = await app.inject({ method: 'GET', url: '/tracearr/' });
      expect(res.body).toContain('<base href="/tracearr/">');
    });

    it('injects <base> tag on nested SPA routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/tracearr/library/watch' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<base href="/tracearr/">');
    });

    // --- Static file serving ---

    it('serves static assets through basePath', async () => {
      const res = await app.inject({ method: 'GET', url: '/tracearr/assets/test.js' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(FAKE_JS);
    });

    // --- API 404 ---

    it('returns 404 JSON for unknown API routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/tracearr/api/v1/nonexistent' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not Found' });
    });
  });

  // ==========================================================================
  // With nested BASE_PATH=/apps/tracearr
  // ==========================================================================
  describe('with nested BASE_PATH=/apps/tracearr', () => {
    const BASE_PATH = '/apps/tracearr';

    beforeEach(async () => {
      app = await buildTestApp(BASE_PATH);
    });

    it('rewrites nested basePath correctly', async () => {
      const res = await app.inject({ method: 'GET', url: '/apps/tracearr/test' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it('redirects / to nested basePath', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/apps/tracearr/');
    });

    it('injects correct <base> tag for nested path', async () => {
      const res = await app.inject({ method: 'GET', url: '/apps/tracearr/' });
      expect(res.body).toContain('<base href="/apps/tracearr/">');
    });
  });

  // ==========================================================================
  // Without BASE_PATH (empty string)
  // ==========================================================================
  describe('without BASE_PATH', () => {
    beforeEach(async () => {
      app = await buildTestApp('');
    });

    // --- No rewriting ---

    it('routes work without rewriting', async () => {
      const res = await app.inject({ method: 'GET', url: '/test' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it('health endpoint works without rewriting', async () => {
      const res = await app.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ status: 'ok' });
    });

    it('API routes work without rewriting', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/settings' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ settings: true });
    });

    // --- No redirect ---

    it('serves / directly (no redirect)', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
    });

    // --- <base href="/"> injection ---

    it('injects <base href="/"> in SPA fallback', async () => {
      const res = await app.inject({ method: 'GET', url: '/' });
      expect(res.body).toContain('<base href="/">');
    });

    it('injects <base href="/"> on nested SPA routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/library/watch' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<base href="/">');
    });

    // --- Static file serving ---

    it('serves static assets at root', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets/test.js' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toBe(FAKE_JS);
    });

    it('404s a hashed chunk that no longer exists instead of serving the SPA html', async () => {
      const res = await app.inject({ method: 'GET', url: '/assets/StreamMap-abc123.js' });
      expect(res.statusCode).toBe(404);
      expect(res.headers['content-type'] ?? '').not.toContain('text/html');
    });

    it('sends the SPA html with no-cache so an upgrade cannot leave stale chunk refs', async () => {
      const res = await app.inject({ method: 'GET', url: '/library/watch' });
      expect(res.headers['cache-control']).toBe('no-cache');
    });

    // --- API 404 ---

    it('returns 404 JSON for unknown API routes', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/nonexistent' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'Not Found' });
    });
  });
});

// ==========================================================================
// API docs basePath derivation (tests the logic from public.ts)
// ==========================================================================
describe('API docs basePath derivation', () => {
  it('extracts basePath from prefixed originalUrl', () => {
    const originalPath = '/tracearr/api/v1/public/docs';
    const basePath = originalPath.replace(/\/api\/v1\/public\/docs$/, '');
    expect(basePath).toBe('/tracearr');
  });

  it('extracts nested basePath from originalUrl', () => {
    const originalPath = '/apps/tracearr/api/v1/public/docs';
    const basePath = originalPath.replace(/\/api\/v1\/public\/docs$/, '');
    expect(basePath).toBe('/apps/tracearr');
  });

  it('returns empty string when no basePath prefix', () => {
    const originalPath = '/api/v1/public/docs';
    const basePath = originalPath.replace(/\/api\/v1\/public\/docs$/, '');
    expect(basePath).toBe('');
  });
});

// ==========================================================================
// BASE_PATH env var normalization
// ==========================================================================
describe('BASE_PATH normalization', () => {
  // Mirrors the production expression from index.ts line 146
  function normalize(raw: string | undefined): string {
    return raw?.replace(/\/+$/, '').replace(/^\/?/, '/') || '';
  }

  // Note: empty string → the regex produces "/" but `|| ''` coerces falsy values.
  // However, "/" is truthy, so `normalize('')` returns "/".
  // In production, process.env.BASE_PATH is either undefined (unset) or a non-empty
  // string, so this edge case doesn't arise. We test the real behavior here.

  it('adds leading slash if missing', () => {
    expect(normalize('tracearr')).toBe('/tracearr');
  });

  it('preserves leading slash', () => {
    expect(normalize('/tracearr')).toBe('/tracearr');
  });

  it('strips trailing slash', () => {
    expect(normalize('/tracearr/')).toBe('/tracearr');
  });

  it('strips multiple trailing slashes', () => {
    expect(normalize('/tracearr///')).toBe('/tracearr');
  });

  it('handles nested paths', () => {
    expect(normalize('apps/tracearr')).toBe('/apps/tracearr');
  });

  it('returns empty string for undefined', () => {
    expect(normalize(undefined)).toBe('');
  });

  it('normalizes empty string to "/" (truthy, so || fallback does not apply)', () => {
    // In production, process.env.BASE_PATH is never set to '' — it's either
    // undefined (unset) or a non-empty string. This documents the actual behavior.
    expect(normalize('')).toBe('/');
  });
});
