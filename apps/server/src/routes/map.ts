/**
 * Map basemap routes
 *
 * Serves the self-hosted PMTiles vector basemap from data/basemap.pmtiles via
 * HTTP range requests. The browser fetches only the byte ranges for tiles in
 * the current viewport, so the archive is never read whole.
 */

import { createReadStream } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import { getAuth } from '../lib/auth.js';

// Same project-root resolution as the GeoLite2 databases in index.ts: works
// from src/ under tsx in dev and from dist/ in the Docker image, where cwd
// and the code location differ.
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

function basemapPath(): string {
  return process.env.MAP_BASEMAP_PATH
    ? resolve(process.env.MAP_BASEMAP_PATH)
    : resolve(PROJECT_ROOT, 'data', 'basemap.pmtiles');
}

const RANGE_RE = /^bytes=(\d+)-(\d*)$/;
const STAT_TTL_MS = 10_000;

interface Archive {
  path: string;
  fh: FileHandle;
  size: number;
  mtimeMs: number;
  etag: string;
  checkedAt: number;
}

let archive: Archive | null = null;

// One open handle serves all range reads via pread; a viewport pan is dozens
// of small ranges and per-request open/stat/close is pure syscall churn. The
// stat is revalidated on a short TTL so a swapped archive is picked up.
async function getArchive(): Promise<Archive | null> {
  const path = basemapPath();
  const now = Date.now();
  if (archive?.path === path && now - archive.checkedAt < STAT_TTL_MS) {
    return archive;
  }
  let info;
  try {
    info = await stat(path);
  } catch {
    await archive?.fh.close().catch(() => undefined);
    archive = null;
    return null;
  }
  if (archive?.path === path && archive.mtimeMs === info.mtimeMs) {
    archive.checkedAt = now;
    return archive;
  }
  await archive?.fh.close().catch(() => undefined);
  archive = {
    path,
    fh: await open(path, 'r'),
    size: info.size,
    mtimeMs: info.mtimeMs,
    etag: `"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`,
    checkedAt: now,
  };
  return archive;
}

// Tiles are public OpenStreetMap-derived bytes, so this is the one authorized
// surface that accepts Better Auth's signed cookie cache instead of forcing a
// session-store lookup: a pan issues dozens of requests, and a revoked session
// keeping basemap access for the cache TTL leaks nothing user-specific.
async function requireSession(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  let session = null;
  try {
    session = await getAuth().api.getSession({ headers: fromNodeHeaders(request.headers) });
  } catch {
    // fail closed
  }
  if (!session) {
    await reply.unauthorized('Authentication required');
  }
}

export const mapRoutes: FastifyPluginAsync = async (app) => {
  // The archive ships in the image, so a missing file means something removed it
  // — almost always a volume mounted over the directory it lives in.
  app.get('/basemap/status', { preHandler: [requireSession] }, async () => {
    const current = await getArchive();
    return { installed: current !== null, path: basemapPath() };
  });

  app.get('/basemap', { preHandler: [requireSession] }, async (request, reply) => {
    const current = await getArchive();
    if (!current) {
      return reply.notFound('Basemap not installed');
    }

    reply.header('Accept-Ranges', 'bytes');
    reply.header('Cache-Control', 'public, max-age=0, must-revalidate');
    reply.header('ETag', current.etag);
    reply.type('application/octet-stream');

    if (request.headers['if-none-match'] === current.etag) {
      return reply.status(304).send();
    }

    const match = RANGE_RE.exec(request.headers.range ?? '');
    if (match?.[1] !== undefined) {
      const start = Number(match[1]);
      const end = match[2] ? Math.min(Number(match[2]), current.size - 1) : current.size - 1;
      if (start >= current.size || start > end) {
        reply.header('Content-Range', `bytes */${current.size}`);
        return reply.status(416).send();
      }
      const length = end - start + 1;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await current.fh.read(buffer, 0, length, start);
      reply.status(206);
      reply.header('Content-Range', `bytes ${start}-${end}/${current.size}`);
      reply.header('Content-Length', bytesRead);
      return reply.send(bytesRead === length ? buffer : buffer.subarray(0, bytesRead));
    }

    reply.header('Content-Length', current.size);
    return reply.send(createReadStream(current.path));
  });
};
