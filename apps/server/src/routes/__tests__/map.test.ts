/**
 * Map basemap route tests
 *
 * GET /map/basemap serves data/basemap.pmtiles with HTTP range support.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getSession = vi.fn();
vi.mock('../../lib/auth.js', () => ({
  getAuth: () => ({ api: { getSession } }),
}));

import { mapRoutes } from '../map.js';

const CONTENT = Buffer.from('0123456789abcdef');

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  await app.register(mapRoutes, { prefix: '/map' });
  return app;
}

describe('GET /map/basemap', () => {
  let app: FastifyInstance;
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'basemap-'));
    await writeFile(join(dir, 'basemap.pmtiles'), CONTENT);
    app = await buildTestApp();
  });

  beforeEach(() => {
    getSession.mockResolvedValue({ user: { id: 'u1' }, session: { id: 's1' } });
  });

  afterEach(() => {
    delete process.env.MAP_BASEMAP_PATH;
    vi.clearAllMocks();
  });

  it('rejects requests without a session', async () => {
    getSession.mockResolvedValue(null);
    process.env.MAP_BASEMAP_PATH = join(dir, 'basemap.pmtiles');
    const res = await app.inject({ method: 'GET', url: '/map/basemap' });
    expect(res.statusCode).toBe(401);
  });

  afterAll(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('returns 404 when the archive is missing', async () => {
    process.env.MAP_BASEMAP_PATH = join(dir, 'nope.pmtiles');
    const res = await app.inject({ method: 'GET', url: '/map/basemap' });
    expect(res.statusCode).toBe(404);
  });

  it('reports the archive as installed', async () => {
    process.env.MAP_BASEMAP_PATH = join(dir, 'basemap.pmtiles');
    const res = await app.inject({ method: 'GET', url: '/map/basemap/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ installed: true, path: join(dir, 'basemap.pmtiles') });
  });

  it('reports the archive as missing when a mount has hidden it', async () => {
    process.env.MAP_BASEMAP_PATH = join(dir, 'nope.pmtiles');
    const res = await app.inject({ method: 'GET', url: '/map/basemap/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ installed: false });
  });

  it('requires a session for status', async () => {
    getSession.mockResolvedValue(null);
    const res = await app.inject({ method: 'GET', url: '/map/basemap/status' });
    expect(res.statusCode).toBe(401);
  });

  it('serves the whole file without a range header', async () => {
    process.env.MAP_BASEMAP_PATH = join(dir, 'basemap.pmtiles');
    const res = await app.inject({ method: 'GET', url: '/map/basemap' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.headers['content-length']).toBe(String(CONTENT.length));
    expect(res.rawPayload.equals(CONTENT)).toBe(true);
  });

  it('serves the requested byte range as 206', async () => {
    process.env.MAP_BASEMAP_PATH = join(dir, 'basemap.pmtiles');
    const res = await app.inject({
      method: 'GET',
      url: '/map/basemap',
      headers: { range: 'bytes=4-7' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 4-7/${CONTENT.length}`);
    expect(res.rawPayload.toString()).toBe('4567');
  });

  it('clamps an open-ended range to the file end', async () => {
    process.env.MAP_BASEMAP_PATH = join(dir, 'basemap.pmtiles');
    const res = await app.inject({
      method: 'GET',
      url: '/map/basemap',
      headers: { range: 'bytes=12-' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.rawPayload.toString()).toBe('cdef');
  });

  it('rejects a range past the end with 416', async () => {
    process.env.MAP_BASEMAP_PATH = join(dir, 'basemap.pmtiles');
    const res = await app.inject({
      method: 'GET',
      url: '/map/basemap',
      headers: { range: `bytes=${CONTENT.length}-` },
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe(`bytes */${CONTENT.length}`);
  });

  it('answers a matching if-none-match with 304', async () => {
    process.env.MAP_BASEMAP_PATH = join(dir, 'basemap.pmtiles');
    const first = await app.inject({ method: 'GET', url: '/map/basemap' });
    const res = await app.inject({
      method: 'GET',
      url: '/map/basemap',
      headers: { 'if-none-match': first.headers.etag as string },
    });
    expect(res.statusCode).toBe(304);
  });
});
