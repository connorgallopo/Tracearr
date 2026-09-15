/**
 * The loopback origin the three showcase servers are seeded with. The image
 * proxy fetches posters through it in both the Plex and the Jellyfin/Emby
 * shape, and the web app loads avatars from it directly. Everything else
 * 404s: the poller hits /status/sessions and friends against the same url and
 * has to fail fast rather than hang.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const POSTER_PATH = /^\/posters\/[A-Za-z0-9._-]+\.webp$/;
const AVATAR_PATH = /^\/avatars\/([A-Za-z0-9._-]+)\.svg$/;
const TRANSCODE_PATH = '/photo/:/transcode';

export interface AssetServer {
  close(): Promise<void>;
}

function fnv1a(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function initialsFor(slug: string, requested: string | null): string {
  const cleaned = (requested ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2);
  if (cleaned) return cleaned.toUpperCase();
  return (slug[0] ?? '?').toUpperCase();
}

function avatarSvg(slug: string, initials: string): string {
  const hash = fnv1a(slug);
  const from = hash % 360;
  const to = (from + 45 + ((hash >>> 9) % 90)) % 360;
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
    '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">',
    `<stop offset="0" stop-color="hsl(${from}, 58%, 46%)"/>`,
    `<stop offset="1" stop-color="hsl(${to}, 62%, 32%)"/>`,
    '</linearGradient></defs>',
    '<rect width="128" height="128" fill="url(#g)"/>',
    '<text x="64" y="64" fill="#ffffff" font-family="system-ui, sans-serif" font-size="52"',
    ' font-weight="600" text-anchor="middle" dominant-baseline="central">',
    initials,
    '</text></svg>',
  ].join('');
}

function notFound(res: ServerResponse): void {
  res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
  res.end('not found');
}

async function sendPoster(
  res: ServerResponse,
  assetsDir: string,
  requestPath: string
): Promise<void> {
  const root = path.resolve(assetsDir);
  const full = path.resolve(root, `.${requestPath}`);
  if (!full.startsWith(`${root}${path.sep}`)) {
    notFound(res);
    return;
  }
  let body: Buffer;
  try {
    body = await readFile(full);
  } catch {
    notFound(res);
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'image/webp',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendAvatar(res: ServerResponse, slug: string, requested: string | null): void {
  const body = Buffer.from(avatarSvg(slug, initialsFor(slug, requested)), 'utf8');
  res.writeHead(200, {
    'Content-Type': 'image/svg+xml',
    'Content-Length': body.byteLength,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handle(req: IncomingMessage, res: ServerResponse, assetsDir: string): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === TRANSCODE_PATH) {
    const target = url.searchParams.get('url');
    const targetPath = target === null ? null : new URL(target, 'http://127.0.0.1').pathname;
    if (targetPath !== null && POSTER_PATH.test(targetPath)) {
      await sendPoster(res, assetsDir, targetPath);
      return;
    }
    notFound(res);
    return;
  }

  const avatar = AVATAR_PATH.exec(pathname);
  if (avatar?.[1] !== undefined) {
    sendAvatar(res, avatar[1], url.searchParams.get('i'));
    return;
  }

  if (POSTER_PATH.test(pathname)) {
    await sendPoster(res, assetsDir, pathname);
    return;
  }

  notFound(res);
}

export function startAssetServer(port: number, assetsDir: string): Promise<AssetServer> {
  const server = createServer((req, res) => {
    handle(req, res, assetsDir).catch(() => {
      if (!res.headersSent) notFound(res);
      else res.end();
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve({
        close: () =>
          new Promise<void>((done, fail) => {
            server.closeAllConnections();
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}
