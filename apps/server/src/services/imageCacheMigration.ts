import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Remove old cropped images once, without changing the shared cache keys. */
export async function migrateImageCache(cacheDir: string): Promise<number> {
  await mkdir(cacheDir, { recursive: true });
  const marker = join(cacheDir, '.uncropped-artwork-v1');
  try {
    if ((await readFile(marker, 'utf8')) === 'complete\n') return 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  let removed = 0;
  const shards = await readdir(cacheDir, { withFileTypes: true });
  for (const shard of shards) {
    if (!shard.isDirectory() || !/^[0-9a-f]{2}$/.test(shard.name)) continue;
    const shardPath = join(cacheDir, shard.name);
    for (const entry of await readdir(shardPath, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !/^[0-9a-f]{16}(?::v[0-9a-f]{8})?\.webp(?:\.tmp\.\d+)?$/.test(entry.name)
      )
        continue;
      try {
        await unlink(join(shardPath, entry.name));
        removed++;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
  // Only mark completion after all cache files have been removed. A failed
  // cleanup is retried on the next startup; unrelated files are never removed.
  await writeFile(marker, 'complete\n');
  return removed;
}
