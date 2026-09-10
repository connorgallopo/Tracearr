import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { migrateImageCache } from '../imageCacheMigration.js';

it('clears only cache images once and preserves images written after migration', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tracearr-image-migration-'));
  try {
    await mkdir(join(dir, 'ab'));
    const image = join(dir, 'ab', 'abcdef0123456789:v01234567.webp');
    const note = join(dir, 'ab', 'keep.txt');
    await writeFile(image, 'cropped');
    await writeFile(note, 'keep');
    expect(await migrateImageCache(dir)).toBe(1);
    await expect(readFile(image)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(note, 'utf8')).toBe('keep');
    await writeFile(image, 'uncropped');
    expect(await migrateImageCache(dir)).toBe(0);
    expect(await readFile(image, 'utf8')).toBe('uncropped');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
