/**
 * Image Proxy Service Tests
 *
 * Exercises the real imageProxy.ts pipeline logic with fs, fetch, and the
 * database fully mocked, so nothing here touches the real cache directory,
 * network, or a live database - safe to run alongside other checkouts.
 */

import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => true),
  mkdirSync: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  rename: vi.fn(),
  stat: vi.fn(),
  unlink: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
}));

vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../imageCacheGuard.js', () => ({
  cacheWriteAllowed: vi.fn(async () => true),
  noteCacheWrite: vi.fn(),
}));

import { readFile, writeFile, rename, stat, unlink, mkdir } from 'node:fs/promises';
import { SsrfBlockedError } from '../../utils/ssrf.js';
import sharp from 'sharp';
import { db } from '../../db/client.js';
import { cacheWriteAllowed } from '../imageCacheGuard.js';
import {
  proxyImage,
  posterVersionFor,
  posterCacheEntryExists,
  posterCacheFileName,
  buildLqipPlaceholder,
  buildUpstreamRequest,
  persistDominantColorIfNeeded,
  _resetServerRowCacheForTests,
} from '../imageProxy.js';

const CACHE_DIR = join(process.cwd(), 'data', 'image-cache');

function mockSelectChain(rows: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

function mockUpdateChain() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

afterEach(() => {
  vi.clearAllMocks();
  _resetServerRowCacheForTests();
});

describe('posterVersionFor', () => {
  it('is stable and matches the first 8 hex chars of sha1(thumbPath)', () => {
    const path = '/library/metadata/123/thumb/456';
    const expected = createHash('sha1').update(path).digest('hex').slice(0, 8);

    expect(posterVersionFor(path)).toBe(expected);
    expect(posterVersionFor(path)).toBe(posterVersionFor(path));
    expect(posterVersionFor(path)).toHaveLength(8);
  });

  it('produces different fingerprints for different paths', () => {
    expect(posterVersionFor('/a')).not.toBe(posterVersionFor('/b'));
  });
});

/** Mirrors buildCacheKeyInfo's derivation so tests can assert the exact path. */
function expectedCachePath(
  serverId: string,
  thumbPath: string,
  width: number,
  height: number
): string {
  const version = posterVersionFor(thumbPath);
  const baseHash = createHash('sha256')
    .update(`${serverId}:${thumbPath}:${width}:${height}`)
    .digest('hex')
    .slice(0, 16);
  const shard = baseHash.slice(0, 2);
  return join(CACHE_DIR, shard, `${baseHash}:v${version}.webp`);
}

describe('posterCacheEntryExists', () => {
  const serverId = 'server-1';
  const thumbPath = '/library/metadata/123/thumb/456';

  it('returns true when the versioned poster cache file exists on disk', async () => {
    vi.mocked(stat).mockResolvedValue({ size: 100, mtimeMs: Date.now() } as never);

    await expect(posterCacheEntryExists(serverId, thumbPath)).resolves.toBe(true);
    expect(vi.mocked(stat)).toHaveBeenCalledWith(expectedCachePath(serverId, thumbPath, 360, 540));
  });

  it('returns false when the cache file is missing', async () => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));

    await expect(posterCacheEntryExists(serverId, thumbPath)).resolves.toBe(false);
  });
});

describe('posterCacheFileName', () => {
  it('matches the pipeline derivation', () => {
    const serverId = randomUUID();
    const path = '/library/metadata/9/thumb/9';
    const baseHash = createHash('sha256')
      .update(`${serverId}:${path}:360:540`)
      .digest('hex')
      .slice(0, 16);
    expect(posterCacheFileName(serverId, path)).toEqual({
      fileName: `${baseHash}:v${posterVersionFor(path)}.webp`,
      shard: baseHash.slice(0, 2),
    });
  });
});

describe('proxyImage poster fingerprint derivation', () => {
  it('derives the fingerprint for a 360x540 poster even when no version was passed', async () => {
    const serverId = randomUUID();
    const path = '/library/metadata/1/thumb/2';
    const version = posterVersionFor(path);
    const baseHash = createHash('sha256')
      .update(`${serverId}:${path}:360:540`)
      .digest('hex')
      .slice(0, 16);
    vi.mocked(stat).mockResolvedValue({ mtimeMs: Date.now() } as never);
    vi.mocked(readFile).mockResolvedValue(Buffer.from('webp'));
    const result = await proxyImage({ serverId, imagePath: path, width: 360, height: 540 });
    expect(result.cached).toBe(true);
    expect(vi.mocked(readFile).mock.calls[0]?.[0]).toBe(
      join(CACHE_DIR, baseHash.slice(0, 2), `${baseHash}:v${version}.webp`)
    );
  });

  it('does not derive a fingerprint for another size or fallback', async () => {
    const serverId = randomUUID();
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    mockSelectChain([]); // no server row → fallback svg
    await proxyImage({ serverId, imagePath: '/x', width: 300, height: 450 });
    expect(String(vi.mocked(stat).mock.calls[0]?.[0]).includes(':v')).toBe(false);
  });
});

describe('buildLqipPlaceholder', () => {
  it('returns valid WebP bytes using the neutral color when dominantColor is null', async () => {
    const data = await buildLqipPlaceholder(null);

    expect(Buffer.isBuffer(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    // WebP container: 'RIFF'....'WEBP'
    expect(data.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(data.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('returns valid WebP bytes for a known dominant color', async () => {
    const data = await buildLqipPlaceholder('#336699');

    expect(data.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(data.subarray(8, 12).toString('ascii')).toBe('WEBP');
  });
});

describe('proxyImage cache-miss pipeline', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  let testImage: Buffer;

  beforeEach(async () => {
    const sharp = (await import('sharp')).default;
    testImage = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 50, g: 100, b: 150 } },
    })
      .jpeg()
      .toBuffer();

    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(readFile).mockResolvedValue(Buffer.from(''));
    vi.mocked(cacheWriteAllowed).mockResolvedValue(true);

    mockUpdateChain();

    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(testImage, { status: 200, headers: { 'content-type': 'image/jpeg' } })
      );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("fetches an allowed outside poster only through the Plex server's transcoder", async () => {
    process.env.EXTERNAL_IMAGE_ORIGINS = 'https://guide.example.com';
    try {
      mockSelectChain([
        { id: 'server-1', type: 'plex', url: 'http://localhost:32400', token: 'token' },
      ]);
      const poster = 'https://guide.example.com/api/programs/abc/artwork/poster';

      const result = await proxyImage({
        serverId: randomUUID(),
        imagePath: poster,
        width: 360,
        height: 540,
        fallback: 'poster',
      });

      expect(result.contentType).toBe('image/webp');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const fetched = new URL(String(fetchSpy.mock.calls[0]?.[0]));
      expect(fetched.origin).toBe('http://localhost:32400');
      expect(fetched.searchParams.get('url')).toBe(poster);
      // The poster's cache entry is versioned by the outside URL's own fingerprint.
      const renamedTo = String(vi.mocked(rename).mock.calls[0]?.[1]);
      expect(renamedTo).toContain(`:v${posterVersionFor(poster)}.webp`);
      // The fire-and-forget color write; drain it so it doesn't leak into the next test.
      await vi.waitFor(() => expect(vi.mocked(db.update)).toHaveBeenCalledTimes(1));
    } finally {
      delete process.env.EXTERNAL_IMAGE_ORIGINS;
    }
  });

  it('returns the placeholder for a historical server without fetching', async () => {
    mockSelectChain([
      {
        id: 'server-h',
        type: 'plex',
        url: 'http://localhost:32400',
        token: 'token',
        historicalAt: new Date('2026-09-01T00:00:00Z'),
      },
    ]);

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/1/thumb/1',
      width: 240,
      height: 360,
    });

    expect(result.contentType).toBe('image/svg+xml');
    expect(result.cached).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
  });

  it('writes atomically: tmp path named after the pid, written before the rename into place', async () => {
    mockSelectChain([
      { id: 'server-1', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/1/thumb/1',
      width: 240,
      height: 360,
    });

    expect(result.cached).toBe(false);
    expect(result.contentType).toBe('image/webp');

    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(rename)).toHaveBeenCalledTimes(1);

    const [tmpPathArg] = vi.mocked(writeFile).mock.calls[0] as [string, Buffer];
    expect(tmpPathArg).toMatch(new RegExp(`\\.tmp\\.${process.pid}$`));

    const [renameFrom, renameTo] = vi.mocked(rename).mock.calls[0] as [string, string];
    expect(renameFrom).toBe(tmpPathArg);
    expect(renameTo).toBe(tmpPathArg.replace(`.tmp.${process.pid}`, ''));
    expect(renameTo.endsWith('.webp')).toBe(true);

    const writeOrder = vi.mocked(writeFile).mock.invocationCallOrder[0];
    const renameOrder = vi.mocked(rename).mock.invocationCallOrder[0];
    expect(writeOrder).toBeLessThan(renameOrder as number);

    // Drain the fire-and-forget color persist so it doesn't leak into the next test.
    await vi.waitFor(() => expect(vi.mocked(db.update)).toHaveBeenCalledTimes(1));
  });

  it('unlinks the tmp file when the atomic write fails, leaving no orphan', async () => {
    mockSelectChain([
      { id: 'server-4', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);
    vi.mocked(writeFile).mockRejectedValueOnce(new Error('disk full'));
    vi.mocked(unlink).mockResolvedValue(undefined);

    await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/4/thumb/4',
      width: 240,
      height: 360,
    });

    expect(vi.mocked(unlink)).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`\\.tmp\\.${process.pid}$`))
    );

    // The fire-and-forget color persist still runs regardless of the write
    // failure; drain it so it doesn't leak into the next test.
    await vi.waitFor(() => expect(vi.mocked(db.update)).toHaveBeenCalledTimes(1));
  });

  it('warns once per error code when the cache directory cannot be written', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.mocked(writeFile).mockRejectedValue(Object.assign(new Error('denied'), { code: 'EACCES' }));
    vi.mocked(unlink).mockResolvedValue(undefined);
    // A Response body reads once, and this test fetches twice.
    fetchSpy.mockImplementation(
      async () =>
        new Response(testImage, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    );

    for (const id of ['5', '6']) {
      mockSelectChain([
        { id: 'server-5', type: 'plex', url: 'http://localhost:32400', token: 'token' },
      ]);
      await proxyImage({
        serverId: randomUUID(),
        imagePath: `/library/metadata/${id}/thumb/${id}`,
        width: 240,
        height: 360,
      });
    }

    expect(vi.mocked(writeFile)).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
    warn.mockRestore();
    await vi.waitFor(() => expect(vi.mocked(db.update)).toHaveBeenCalledTimes(2));
  });

  it('persists the dominant color only when the row does not have one yet', async () => {
    mockSelectChain([
      { id: 'server-2', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);
    const updateChain = mockUpdateChain();

    await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/2/thumb/2',
      width: 240,
      height: 360,
    });

    // The color write is fire-and-forget so the response doesn't wait on it;
    // give it a chance to land before asserting.
    await vi.waitFor(() => expect(vi.mocked(db.update)).toHaveBeenCalledTimes(1));
    expect(updateChain.set).toHaveBeenCalledWith(
      expect.objectContaining({ dominantColor: expect.stringMatching(/^#[0-9a-f]{6}$/) })
    );
  });

  it('applies EXIF orientation before the tag is dropped, so a phone photo avatar stays upright', async () => {
    // Stored red-over-blue, tagged "rotate 180": displayed as blue over red
    const pixels = Buffer.alloc(8 * 8 * 3);
    for (let i = 0; i < 64; i++) pixels.set(i < 32 ? [255, 0, 0] : [0, 0, 255], i * 3);
    const tagged = await sharp(pixels, { raw: { width: 8, height: 8, channels: 3 } })
      .jpeg()
      .withMetadata({ orientation: 3 })
      .toBuffer();
    fetchSpy.mockResolvedValue(
      new Response(tagged, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    );
    mockSelectChain([
      { id: 'server-4', type: 'jellyfin', url: 'http://localhost:8096', token: 'token' },
    ]);

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/Users/abc/Images/Primary',
      width: 40,
      height: 40,
      fallback: 'avatar',
    });

    const { data } = await sharp(result.data)
      .extract({ left: 0, top: 0, width: 1, height: 1 })
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(data[2]).toBeGreaterThan(200);
    expect(data[0]).toBeLessThan(60);

    await vi.waitFor(() => expect(vi.mocked(db.update)).toHaveBeenCalledTimes(1));
  });

  it('falls back to the SVG placeholder with a short, non-immutable cacheControl and drains the body on an upstream HTTP error', async () => {
    mockSelectChain([
      { id: 'server-8', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);
    // Response.body is normally a ReadableStream; stub cancel to observe the drain.
    const cancel = vi.fn().mockResolvedValue(undefined);
    const errorResponse = new Response('server error', { status: 502 });
    Object.defineProperty(errorResponse, 'body', { value: { cancel } });
    fetchSpy.mockResolvedValue(errorResponse);

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/8/thumb/8',
      width: 240,
      height: 360,
    });

    expect(result.contentType).toBe('image/svg+xml');
    expect(result.cacheControl).toBe('public, max-age=15');
    // Both upstream candidates (server-resized, then original) hit the same
    // erroring mock, and each drains its body.
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('returns the degraded placeholder for a path outside the image routes without fetching', async () => {
    mockSelectChain([
      { id: 'server-9', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/sections',
      width: 240,
      height: 360,
    });

    expect(result.contentType).toBe('image/svg+xml');
    expect(result.cacheControl).toBe('public, max-age=15');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with lqip, races the miss against the LQIP placeholder once the semaphore wait timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      mockSelectChain([
        { id: 'server-9', type: 'plex', url: 'http://localhost:32400', token: 'token' },
      ]);

      let resolveFetch!: (value: Response) => void;
      fetchSpy.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );

      const resultPromise = proxyImage({
        serverId: randomUUID(),
        imagePath: '/library/metadata/9/thumb/9',
        width: 360,
        height: 540,
        lqip: true,
      });

      // Past the 2s semaphore-wait timeout: the race resolves with the
      // placeholder instead of waiting on the still-unsettled upstream fetch.
      await vi.advanceTimersByTimeAsync(2100);
      const result = await resultPromise;

      expect(result.contentType).toBe('image/webp');
      // A 1x1 LQIP placeholder is a handful of bytes; a real resized poster is much bigger.
      expect(result.data.byteLength).toBeLessThan(50);

      resolveFetch(new Response(testImage, { status: 200 }));
    } finally {
      vi.useRealTimers();
    }
    // The background pipeline is still resolving after the race returned;
    // drain its write so it doesn't leak into a later test.
    await vi.waitFor(() => expect(vi.mocked(writeFile)).toHaveBeenCalled());
  });

  it('without lqip, waits for the real pipeline past the semaphore wait timeout instead of racing the LQIP placeholder', async () => {
    // Everything except the web grid's lqip:true request must get the real
    // image; a client caching by URL alone can't revalidate a placeholder later.
    vi.useFakeTimers();
    try {
      mockSelectChain([
        { id: 'server-10', type: 'plex', url: 'http://localhost:32400', token: 'token' },
      ]);

      let resolveFetch!: (value: Response) => void;
      fetchSpy.mockImplementation(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          })
      );

      let settled = false;
      const resultPromise = proxyImage({
        serverId: randomUUID(),
        imagePath: '/library/metadata/10/thumb/10',
        width: 240,
        height: 360,
      }).then((result) => {
        settled = true;
        return result;
      });

      // Past the 2s semaphore-wait timeout that would otherwise trigger the LQIP race.
      await vi.advanceTimersByTimeAsync(2100);
      expect(settled).toBe(false);

      resolveFetch(new Response(testImage, { status: 200 }));
      const result = await resultPromise;

      expect(settled).toBe(true);
      expect(result.contentType).toBe('image/webp');
      // A 1x1 LQIP placeholder is a handful of bytes; a real resized poster is much bigger.
      expect(result.data.byteLength).toBeGreaterThan(50);
    } finally {
      vi.useRealTimers();
    }
  });

  it('serves the resized image without writing to disk when the guard refuses the write', async () => {
    mockSelectChain([
      { id: 'server-11', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);
    vi.mocked(cacheWriteAllowed).mockResolvedValueOnce(false);

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/11/thumb/11',
      width: 240,
      height: 360,
    });

    expect(vi.mocked(writeFile)).not.toHaveBeenCalled();
    expect(result.cached).toBe(false);
    expect(result.contentType).toBe('image/webp');
    expect(result.data.byteLength).toBeGreaterThan(50);
  });
});

describe('persistDominantColorIfNeeded', () => {
  const red1x1 = () =>
    sharp(Buffer.from([255, 0, 0]), { raw: { width: 1, height: 1, channels: 3 } })
      .png()
      .toBuffer();

  it('coalesces concurrent persists for the same image into one write', async () => {
    // Fire-and-forget persists from earlier proxyImage tests can settle
    // during this one and hit the shared db.update mock - drain them and
    // count only writes carrying this test's color
    await new Promise((resolve) => setTimeout(resolve, 20));
    vi.clearAllMocks();

    // The miss pipeline runs per size, so one poster at 160/240/360 lands
    // here three times at once - the shape that deadlocks multi-row updates
    const chain = mockUpdateChain();
    const serverId = randomUUID();
    const buffer = await red1x1();

    await Promise.all([
      persistDominantColorIfNeeded(serverId, '/thumb/coalesce', buffer),
      persistDominantColorIfNeeded(serverId, '/thumb/coalesce', buffer),
      persistDominantColorIfNeeded(serverId, '/thumb/coalesce', buffer),
    ]);

    const redWrites = chain.set.mock.calls.filter(
      (call) => (call[0] as { dominantColor?: string }).dominantColor === '#ff0000'
    );
    expect(redWrites).toHaveLength(1);
  });

  it('retries once after a deadlock and succeeds', async () => {
    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi
        .fn()
        .mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code: '40P01' }))
        .mockResolvedValueOnce(undefined),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);

    await persistDominantColorIfNeeded(randomUUID(), '/thumb/deadlock', await red1x1());

    expect(chain.where).toHaveBeenCalledTimes(2);
    expect(chain.set).toHaveBeenCalledWith({ dominantColor: '#ff0000' });
  });

  it('recognizes a wrapped deadlock via the error cause', async () => {
    const wrapped = Object.assign(new Error('query failed'), {
      cause: Object.assign(new Error('deadlock detected'), { code: '40P01' }),
    });
    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValueOnce(wrapped).mockResolvedValueOnce(undefined),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);

    await persistDominantColorIfNeeded(randomUUID(), '/thumb/wrapped', await red1x1());

    expect(chain.where).toHaveBeenCalledTimes(2);
  });

  it('does not retry non-deadlock failures and never throws', async () => {
    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: '23505' })),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);

    await expect(
      persistDominantColorIfNeeded(randomUUID(), '/thumb/other-error', await red1x1())
    ).resolves.toBeUndefined();

    expect(chain.where).toHaveBeenCalledTimes(1);
  });
});

describe('buildUpstreamRequest', () => {
  const baseServer = {
    id: randomUUID(),
    name: 'Test',
    url: 'http://media:1234/',
    token: 'tok123',
  };

  it('plex without resize appends the token to the raw path', () => {
    const server = { ...baseServer, type: 'plex' } as never;
    const { imageUrl } = buildUpstreamRequest(server, '/library/metadata/1/thumb/2');
    expect(imageUrl).toBe('http://media:1234/library/metadata/1/thumb/2?X-Plex-Token=tok123');
  });

  it('plex with resize routes through the photo transcoder with the path encoded', () => {
    const server = { ...baseServer, type: 'plex' } as never;
    const { imageUrl } = buildUpstreamRequest(server, '/library/metadata/1/thumb/2', {
      width: 240,
      height: 360,
    });
    const url = new URL(imageUrl);
    expect(url.pathname).toBe('/photo/:/transcode');
    expect(url.searchParams.get('width')).toBe('240');
    expect(url.searchParams.get('height')).toBe('360');
    expect(url.searchParams.get('upscale')).toBe('0');
    expect(url.searchParams.get('minSize')).toBe('1');
    expect(url.searchParams.get('url')).toBe('/library/metadata/1/thumb/2');
    expect(url.searchParams.get('X-Plex-Token')).toBe('tok123');
  });

  it('jellyfin portrait resize constrains the long axis via maxHeight', () => {
    const server = { ...baseServer, type: 'jellyfin' } as never;
    const { imageUrl, headers } = buildUpstreamRequest(server, '/Items/abc/Images/Primary', {
      width: 240,
      height: 360,
    });
    expect(imageUrl).toBe('http://media:1234/Items/abc/Images/Primary?maxHeight=360&quality=90');
    expect(headers['Authorization']).toBe('MediaBrowser Token="tok123"');
  });

  it('emby landscape resize constrains the long axis via maxWidth', () => {
    const server = { ...baseServer, type: 'emby' } as never;
    const { imageUrl, headers } = buildUpstreamRequest(server, '/Items/9/Images/Primary', {
      width: 500,
      height: 280,
    });
    expect(imageUrl).toBe('http://media:1234/Items/9/Images/Primary?maxWidth=500&quality=90');
    expect(headers['X-Emby-Token']).toBe('tok123');
  });

  it('preserves an existing query string when appending resize params', () => {
    const server = { ...baseServer, type: 'jellyfin' } as never;
    const { imageUrl } = buildUpstreamRequest(server, '/Items/abc/Images/Primary?tag=5', {
      width: 240,
      height: 360,
    });
    expect(imageUrl).toBe(
      'http://media:1234/Items/abc/Images/Primary?tag=5&maxHeight=360&quality=90'
    );
  });

  describe('path allowlist', () => {
    it.each([
      ['plex', '/library/metadata/1/thumb/..\\..\\..\\..\\library\\sections\\1\\refresh'],
      ['plex', '/library/metadata/1/thumb/../../../../library/sections/1/refresh'],
      ['plex', '/library/metadata/1/thumb/%2e%2e%2f%2e%2e%2flibrary%2fsections'],
      ['plex', '/library/metadata/1/thumb/%5C..%5Clibrary'],
      ['plex', '/library/metadata/1/thumb/2%00'],
      ['plex', '/library/metadata/1/thumb/%252e%252e%252flibrary%252fsections'],
      ['jellyfin', '/Items/..\\..\\System\\Info/Images/Primary'],
      ['jellyfin', '/Items/%2E%2E/Images/Primary'],
      ['emby', '/Users/..\\..\\System\\Info/Images/Primary'],
    ])('rejects a %s path that walks out of the image route: %s', (type, path) => {
      const server = { ...baseServer, type } as never;
      expect(() => buildUpstreamRequest(server, path)).toThrow(SsrfBlockedError);
    });

    it('still builds an ordinary image path, also under a base path', () => {
      const plex = { ...baseServer, type: 'plex' } as never;
      expect(buildUpstreamRequest(plex, '/library/metadata/1/thumb/1700000000').imageUrl).toContain(
        '/library/metadata/1/thumb/1700000000?X-Plex-Token='
      );
      const jf = {
        ...baseServer,
        type: 'jellyfin',
        url: 'http://jf.local:8096/jellyfin/',
      } as never;
      expect(buildUpstreamRequest(jf, '/Items/abc/Images/Primary?tag=f00').imageUrl).toBe(
        'http://jf.local:8096/jellyfin/Items/abc/Images/Primary?tag=f00'
      );
    });

    it('rejects a plex path outside library image routes', () => {
      const server = { ...baseServer, type: 'plex' } as never;
      expect(() => buildUpstreamRequest(server, '/library/sections')).toThrow(SsrfBlockedError);
      expect(() => buildUpstreamRequest(server, '/:/scrobble?key=1')).toThrow(SsrfBlockedError);
      expect(() => buildUpstreamRequest(server, '/library/metadata/1/thumb/2?download=1')).toThrow(
        SsrfBlockedError
      );
    });

    it('rejects a jellyfin or emby path outside the Items and Users image routes', () => {
      const jf = { ...baseServer, type: 'jellyfin' } as never;
      const emby = { ...baseServer, type: 'emby' } as never;
      expect(() => buildUpstreamRequest(jf, '/System/Info')).toThrow(SsrfBlockedError);
      expect(() => buildUpstreamRequest(emby, '/Items/9/Download')).toThrow(SsrfBlockedError);
    });

    it('accepts every image shape Tracearr stores', () => {
      const plex = { ...baseServer, type: 'plex' } as never;
      const jf = { ...baseServer, type: 'jellyfin' } as never;
      const emby = { ...baseServer, type: 'emby' } as never;
      const hex = '0123456789abcdef0123456789abcdef';
      expect(() => buildUpstreamRequest(plex, '/library/metadata/12/thumb/34')).not.toThrow();
      expect(() =>
        buildUpstreamRequest(plex, '/library/metadata/12/thumb/34', { width: 240, height: 360 })
      ).not.toThrow();
      expect(() =>
        buildUpstreamRequest(jf, `/Items/${hex}/Images/Primary?tag=${hex}`)
      ).not.toThrow();
      expect(() => buildUpstreamRequest(jf, `/Users/${hex}/Images/Primary`)).not.toThrow();
      expect(() =>
        buildUpstreamRequest(emby, `/Items/9/Images/Primary?tag=${hex}_1`)
      ).not.toThrow();
      expect(() => buildUpstreamRequest(emby, '/Items/9/Images/Primary')).not.toThrow();
    });
  });

  describe('origin pinning', () => {
    // The attack only parses when the configured URL has no explicit port:
    // with one, "32400.evil" is an invalid port and the URL is rejected anyway.
    const portless = { ...baseServer, url: 'https://jf.example.com' };

    it('rejects a suffix that moves the request to another host', () => {
      const server = { ...portless, type: 'jellyfin' } as never;
      expect(() => buildUpstreamRequest(server, '.attacker.example/x')).toThrow();
      expect(() =>
        buildUpstreamRequest(server, '.attacker.example/x', { width: 240, height: 360 })
      ).toThrow();
    });

    it('rejects a plex path that moves the host, which would leak the token', () => {
      const server = { ...portless, type: 'plex' } as never;
      expect(() => buildUpstreamRequest(server, '.attacker.example/x')).toThrow();
    });

    it('rejects injected URL credentials', () => {
      const server = { ...portless, type: 'jellyfin' } as never;
      expect(() => buildUpstreamRequest(server, '@evil.test/x')).toThrow();
    });

    it('rejects an absolute URL', () => {
      const server = { ...portless, type: 'jellyfin' } as never;
      expect(() => buildUpstreamRequest(server, 'https://evil.test/x')).toThrow();
    });

    it('still builds a normal relative path on a portless server', () => {
      const server = { ...portless, type: 'jellyfin' } as never;
      const { imageUrl } = buildUpstreamRequest(server, '/Items/abc/Images/Primary');
      expect(imageUrl).toBe('https://jf.example.com/Items/abc/Images/Primary');
    });

    it('rejects a protocol-relative path', () => {
      const server = { ...portless, type: 'jellyfin' } as never;
      expect(() => buildUpstreamRequest(server, '//evil.test/x')).toThrow(SsrfBlockedError);
    });
  });

  describe('outside picture URLs (EXTERNAL_IMAGE_ORIGINS)', () => {
    const plex = { ...baseServer, type: 'plex' } as never;
    const poster = 'https://guide.example.com/api/programs/abc/artwork/poster';

    afterEach(() => {
      delete process.env.EXTERNAL_IMAGE_ORIGINS;
    });

    it('refuses every absolute URL when the variable is unset', () => {
      expect(() => buildUpstreamRequest(plex, poster)).toThrow(SsrfBlockedError);
      expect(() => buildUpstreamRequest(plex, poster, { width: 240, height: 360 })).toThrow(
        SsrfBlockedError
      );
    });

    it("fetches a listed origin's picture through the Plex server's photo transcoder", () => {
      process.env.EXTERNAL_IMAGE_ORIGINS = 'https://guide.example.com';
      const { imageUrl } = buildUpstreamRequest(plex, poster, { width: 240, height: 360 });
      const url = new URL(imageUrl);
      expect(url.origin).toBe('http://media:1234');
      expect(url.pathname).toBe('/photo/:/transcode');
      expect(url.searchParams.get('url')).toBe(poster);
      expect(url.searchParams.get('width')).toBe('240');
      expect(url.searchParams.get('height')).toBe('360');
      expect(url.searchParams.get('X-Plex-Token')).toBe('tok123');
    });

    it('always resizes, using the poster size when no size is given', () => {
      process.env.EXTERNAL_IMAGE_ORIGINS = 'https://guide.example.com';
      const url = new URL(buildUpstreamRequest(plex, poster).imageUrl);
      expect(url.pathname).toBe('/photo/:/transcode');
      expect(url.searchParams.get('width')).toBe('360');
      expect(url.searchParams.get('height')).toBe('540');
    });

    it('accepts a versioned picture and any origin in a comma-separated list', () => {
      process.env.EXTERNAL_IMAGE_ORIGINS =
        ' https://other.example.org , https://guide.example.com ';
      const versioned = 'https://guide.example.com/media/artwork/abc-poster.jpg?v=20261015041230';
      const url = new URL(buildUpstreamRequest(plex, versioned).imageUrl);
      expect(url.searchParams.get('url')).toBe(versioned);
    });

    it.each([
      ['another origin', 'https://evil.example.com/x.jpg'],
      ['a look-alike host', 'https://guide.example.com.evil.example/x.jpg'],
      ['another scheme', 'http://guide.example.com/x.jpg'],
      ['another port', 'https://guide.example.com:8443/x.jpg'],
      ['credentials', 'https://user:pass@guide.example.com/x.jpg'],
      ['an encoded path', 'https://guide.example.com/a/%2e%2e/x.jpg'],
      ['a backslash', 'https://guide.example.com/a\\..\\x.jpg'],
      ['a fragment', 'https://guide.example.com/x.jpg#y'],
      ['a non-canonical host', 'https://GUIDE.example.com/x.jpg'],
      ['a dot segment', 'https://guide.example.com/a/../x.jpg'],
    ])('refuses %s', (_label, imagePath) => {
      process.env.EXTERNAL_IMAGE_ORIGINS = 'https://guide.example.com';
      expect(() => buildUpstreamRequest(plex, imagePath)).toThrow(SsrfBlockedError);
    });

    it('keeps refusing absolute URLs for Jellyfin and Emby', () => {
      process.env.EXTERNAL_IMAGE_ORIGINS = 'https://guide.example.com';
      const jf = { ...baseServer, type: 'jellyfin' } as never;
      const emby = { ...baseServer, type: 'emby' } as never;
      expect(() => buildUpstreamRequest(jf, poster)).toThrow(SsrfBlockedError);
      expect(() => buildUpstreamRequest(emby, poster)).toThrow(SsrfBlockedError);
    });

    it('ignores an entry that is not an origin', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env.EXTERNAL_IMAGE_ORIGINS = 'guide.example.com, ftp://guide.example.com';
      expect(() => buildUpstreamRequest(plex, poster)).toThrow(SsrfBlockedError);
      expect(warn).toHaveBeenCalledTimes(2);
      warn.mockRestore();
    });

    it.each([
      ['a path', 'https://guide.example.com/api'],
      ['a query', 'https://guide.example.com/?a=1'],
      ['a fragment', 'https://guide.example.com/#a'],
      ['credentials', 'https://user:pass@guide.example.com'],
    ])('ignores an entry with %s rather than allowing its whole host', (_label, entry) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      process.env.EXTERNAL_IMAGE_ORIGINS = entry;
      expect(() => buildUpstreamRequest(plex, poster)).toThrow(SsrfBlockedError);
      expect(warn).toHaveBeenCalledTimes(1);
      warn.mockRestore();
    });

    it('accepts an origin written with a trailing slash', () => {
      process.env.EXTERNAL_IMAGE_ORIGINS = 'https://guide.example.com/';
      expect(() => buildUpstreamRequest(plex, poster)).not.toThrow();
    });
  });
});

describe('resizedOnly (background warms)', () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.mocked(stat).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(mkdir).mockResolvedValue(undefined);
    vi.mocked(writeFile).mockResolvedValue(undefined);
    vi.mocked(rename).mockResolvedValue(undefined);
    vi.mocked(cacheWriteAllowed).mockResolvedValue(true);
    mockUpdateChain();
    mockSelectChain([
      { id: 'server-1', type: 'plex', url: 'http://localhost:32400', token: 'token' },
    ]);
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('does not retry the full-size original, so a struggling transcoder is not asked for more', async () => {
    await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/1/thumb/1',
      width: 360,
      height: 540,
      fallback: 'poster',
      resizedOnly: true,
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toContain('width=360');
  });

  it('treats a redirect from the media server as a failed fetch instead of following it', async () => {
    fetchSpy.mockResolvedValue(
      new Response(null, { status: 302, headers: { location: 'http://elsewhere.example/x' } })
    );
    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/4/thumb/1',
      width: 360,
      height: 540,
      fallback: 'poster',
    });

    expect(result.contentType).toBe('image/svg+xml');
    for (const [, init] of fetchSpy.mock.calls) {
      expect((init as RequestInit).redirect).toBe('manual');
    }
  });

  it('still retries the original for a live request', async () => {
    await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/2/thumb/1',
      width: 360,
      height: 540,
      fallback: 'poster',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('tries an outside picture once, since a retry would be the same transcoder request', async () => {
    process.env.EXTERNAL_IMAGE_ORIGINS = 'https://guide.example.com';
    try {
      const result = await proxyImage({
        serverId: randomUUID(),
        imagePath: 'https://guide.example.com/api/programs/abc/artwork/poster',
        width: 360,
        height: 540,
        fallback: 'poster',
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(result.degraded).toBe(true);
    } finally {
      delete process.env.EXTERNAL_IMAGE_ORIGINS;
    }
  });

  it('flags the placeholder as degraded rather than rejecting, since live requests share the promise', async () => {
    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/3/thumb/1',
      width: 360,
      height: 540,
      fallback: 'poster',
      resizedOnly: true,
    });

    expect(result.degraded).toBe(true);
    expect(result.contentType).toBe('image/svg+xml');
    expect(result.failure).toEqual({ reason: 'HTTP 500 (no content-type)', itemFault: true });
  });

  it('blames the server, not the image, when it never answers', async () => {
    fetchSpy.mockRejectedValue(new TypeError('fetch failed'));

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/5/thumb/1',
      width: 360,
      height: 540,
      fallback: 'poster',
      resizedOnly: true,
    });

    expect(result.failure).toEqual({ reason: 'fetch failed', itemFault: false });
  });

  it.each([401, 403, 429, 502, 503, 504])(
    'blames the server, not the image, for an HTTP %i every image would get',
    async (status) => {
      fetchSpy.mockResolvedValue(new Response(null, { status }));

      const result = await proxyImage({
        serverId: randomUUID(),
        imagePath: '/library/metadata/6/thumb/1',
        width: 360,
        height: 540,
        fallback: 'poster',
        resizedOnly: true,
      });

      expect(result.failure).toEqual({
        reason: `HTTP ${status} (no content-type)`,
        itemFault: false,
      });
    }
  );

  it('blames the image for a 404', async () => {
    fetchSpy.mockResolvedValue(new Response(null, { status: 404 }));

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/7/thumb/1',
      width: 360,
      height: 540,
      fallback: 'poster',
      resizedOnly: true,
    });

    expect(result.failure).toEqual({ reason: 'HTTP 404 (no content-type)', itemFault: true });
  });

  it('does not flag a successful fetch as degraded', async () => {
    const png = await sharp({
      create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();
    fetchSpy.mockResolvedValue(
      new Response(png, { status: 200, headers: { 'content-type': 'image/jpeg' } })
    );

    const result = await proxyImage({
      serverId: randomUUID(),
      imagePath: '/library/metadata/4/thumb/1',
      width: 360,
      height: 540,
      fallback: 'poster',
      resizedOnly: true,
    });

    expect(result.degraded).toBeUndefined();
  });
});

describe('IMAGE_CACHE_DIR', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('defaults to data/image-cache under the working directory', async () => {
    vi.resetModules();
    const mod = await import('../imageProxy.js');
    expect(mod.IMAGE_CACHE_DIR).toBe(join(process.cwd(), 'data', 'image-cache'));
  });

  it('honours IMAGE_CACHE_DIR so a deployment can point it at a mounted volume', async () => {
    vi.resetModules();
    vi.stubEnv('IMAGE_CACHE_DIR', '/data/tracearr/image-cache');
    const mod = await import('../imageProxy.js');
    expect(mod.IMAGE_CACHE_DIR).toBe('/data/tracearr/image-cache');
  });
});
