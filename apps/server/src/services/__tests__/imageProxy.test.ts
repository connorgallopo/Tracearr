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

  it.each(['jellyfin', 'emby', 'plex'])(
    'preserves wide and tall poster artwork for %s',
    async (type) => {
      const updates = mockUpdateChain();
      let persisted = 0;
      mockSelectChain([{ id: 'server-1', type, url: 'http://localhost:8096', token: 'token' }]);
      for (const [width, height] of [
        [800, 200],
        [200, 800],
        [360, 540],
      ] as const) {
        const input = await sharp({
          create: { width, height, channels: 4, background: '#ff000080' },
        })
          .png()
          .toBuffer();
        fetchSpy.mockImplementation(async () => new Response(input, { status: 200 }));
        const result = await proxyImage({
          serverId: randomUUID(),
          imagePath: '/Items/art/Images/Primary',
          width: 360,
          height: 540,
        });
        const meta = await sharp(result.data).metadata();
        expect((meta.width ?? 0) / (meta.height ?? 1)).toBeCloseTo(width / height, 2);
        expect(meta.width).toBeLessThanOrEqual(360);
        expect(meta.height).toBeLessThanOrEqual(540);
        expect(meta.hasAlpha).toBe(true);
        persisted++;
        await vi.waitFor(() => expect(updates.set).toHaveBeenCalledTimes(persisted));
      }
    }
  );

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

  it('fetches Dispatcharr relative logos without proxy headers and resizes them inside', async () => {
    mockSelectChain([
      {
        id: 'server-dispatcharr',
        type: 'dispatcharr',
        url: 'http://dispatcharr.local/',
        token: 'token',
      },
    ]);

    const result = await proxyImage({
      serverId: 'server-dispatcharr',
      imagePath: '/api/channels/logos/4671/cache/',
      width: 200,
      height: 300,
    });

    expect(result.contentType).toBe('image/webp');
    expect(result.data.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://dispatcharr.local/api/channels/logos/4671/cache/',
      expect.objectContaining({ headers: {}, signal: expect.any(AbortSignal) })
    );

    const metadata = await (await import('sharp')).default(result.data).metadata();
    expect(metadata.width).toBeLessThanOrEqual(200);
    expect(metadata.height).toBeLessThanOrEqual(300);
    expect(metadata.width / metadata.height).toBeCloseTo(1, 1);
  });

  it('normalizes absolute Dispatcharr logo URLs to the configured server while preserving query strings', async () => {
    mockSelectChain([
      {
        id: 'server-dispatcharr-absolute',
        type: 'dispatcharr',
        url: 'https://configured.dispatcharr.example',
        token: 'token',
      },
    ]);

    const result = await proxyImage({
      serverId: 'server-dispatcharr-absolute',
      imagePath: 'https://other.example/api/channels/logos/4671/cache/?ts=123#ignored',
      width: 200,
      height: 300,
    });

    expect(result.contentType).toBe('image/webp');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://configured.dispatcharr.example/api/channels/logos/4671/cache/?ts=123',
      expect.objectContaining({ headers: {} })
    );
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

  it('fetches the Plex source for uncropped posters without the fill transcoder', () => {
    const server = { ...baseServer, type: 'plex' } as never;
    const { imageUrl } = buildUpstreamRequest(server, '/library/metadata/1/thumb/2', {
      width: 360,
      height: 540,
      preserveAspectRatio: true,
    });
    expect(new URL(imageUrl).pathname).toBe('/library/metadata/1/thumb/2');
  });

  it.each(['jellyfin', 'emby'])(
    'bounds both dimensions without cropping for %s posters',
    (type) => {
      const server = { ...baseServer, type } as never;
      const { imageUrl } = buildUpstreamRequest(server, '/Items/abc/Images/Primary', {
        width: 360,
        height: 540,
        preserveAspectRatio: true,
      });
      const url = new URL(imageUrl);
      expect(url.searchParams.get('maxWidth')).toBe('360');
      expect(url.searchParams.get('maxHeight')).toBe('540');
    }
  );

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
    const { imageUrl, headers } = buildUpstreamRequest(server, '/emby/Items/9/Images/Backdrop', {
      width: 500,
      height: 280,
    });
    expect(imageUrl).toBe('http://media:1234/emby/Items/9/Images/Backdrop?maxWidth=500&quality=90');
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

    it('treats a protocol-relative path as a path on the configured host', () => {
      const server = { ...portless, type: 'jellyfin' } as never;
      const { imageUrl } = buildUpstreamRequest(server, '//evil.test/x');
      expect(new URL(imageUrl).host).toBe('jf.example.com');
    });
  });
});
