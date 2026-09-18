/**
 * Uploaded Jellystat backups wait on disk for the import worker. Job data
 * holds the path only: BullMQ serialises job data into Redis and loads it
 * back on every status lookup, which a backup of several hundred MB cannot
 * afford.
 */

import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export const JELLYSTAT_UPLOAD_DIR = join(tmpdir(), 'tracearr-jellystat-uploads');

const STALE_UPLOAD_AGE_MS = 60 * 60 * 1000;

export class JellystatUploadMissingError extends Error {
  constructor(cause?: unknown) {
    super('The uploaded Jellystat backup is no longer on the server. Upload it again.', { cause });
    this.name = 'JellystatUploadMissingError';
  }
}

function isUploadPath(path: string): boolean {
  return dirname(resolve(path)) === JELLYSTAT_UPLOAD_DIR;
}

export async function saveJellystatUpload(file: Readable): Promise<string> {
  await mkdir(JELLYSTAT_UPLOAD_DIR, { recursive: true });
  const path = join(JELLYSTAT_UPLOAD_DIR, `${randomUUID()}.backup`);
  try {
    await pipeline(file, createWriteStream(path, { mode: 0o600 }));
  } catch (error) {
    await rm(path, { force: true });
    throw error;
  }
  return path;
}

export async function readJellystatUpload(path: string): Promise<string> {
  if (!isUploadPath(path)) throw new JellystatUploadMissingError();
  try {
    return await readFile(path, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new JellystatUploadMissingError(error);
    }
    throw error;
  }
}

export async function removeJellystatUpload(path: string | undefined): Promise<void> {
  if (!path || !isUploadPath(path)) return;
  await rm(path, { force: true });
}

export async function clearJellystatUploads(): Promise<void> {
  await rm(JELLYSTAT_UPLOAD_DIR, { recursive: true, force: true });
}

/**
 * Removes uploads no queued job points at. An upload is on disk before its
 * job exists, so anything written in the last hour is left alone.
 */
export async function sweepJellystatUploads(inUse: ReadonlySet<string>): Promise<number> {
  const names = await readdir(JELLYSTAT_UPLOAD_DIR).catch(() => []);
  let removed = 0;
  for (const name of names) {
    const path = join(JELLYSTAT_UPLOAD_DIR, name);
    if (inUse.has(path)) continue;
    const info = await stat(path).catch(() => null);
    if (!info || Date.now() - info.mtimeMs < STALE_UPLOAD_AGE_MS) continue;
    await rm(path, { force: true });
    removed++;
  }
  return removed;
}
