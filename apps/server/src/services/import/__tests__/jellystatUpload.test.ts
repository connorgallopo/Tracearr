import { existsSync } from 'node:fs';
import { readFile, utimes } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';

import {
  JellystatUploadMissingError,
  clearJellystatUploads,
  readJellystatUpload,
  removeJellystatUpload,
  saveJellystatUpload,
  sweepJellystatUploads,
} from '../jellystatUpload.js';

async function saveAged(text: string, ageMs: number): Promise<string> {
  const path = await saveJellystatUpload(Readable.from([text]));
  const when = new Date(Date.now() - ageMs);
  await utimes(path, when, when);
  return path;
}

describe('jellystatUpload', () => {
  afterEach(async () => {
    await clearJellystatUploads();
  });

  it('writes the upload to disk and reads it back', async () => {
    const path = await saveJellystatUpload(Readable.from(['[{"a":', '1}]']));

    expect(await readFile(path, 'utf-8')).toBe('[{"a":1}]');
    expect(await readJellystatUpload(path)).toBe('[{"a":1}]');
  });

  it('reports a missing upload, and a path outside the upload folder, as missing', async () => {
    const path = await saveJellystatUpload(Readable.from(['x']));
    await removeJellystatUpload(path);

    await expect(readJellystatUpload(path)).rejects.toBeInstanceOf(JellystatUploadMissingError);
    await expect(readJellystatUpload('/etc/hosts')).rejects.toBeInstanceOf(
      JellystatUploadMissingError
    );
  });

  it('sweeps old uploads no job points at and keeps the rest', async () => {
    const twoHours = 2 * 60 * 60 * 1000;
    const orphan = await saveAged('orphan', twoHours);
    const queued = await saveAged('queued', twoHours);
    const fresh = await saveAged('fresh', 0);

    expect(await sweepJellystatUploads(new Set([queued]))).toBe(1);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(queued)).toBe(true);
    expect(existsSync(fresh)).toBe(true);
  });
});
