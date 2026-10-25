/**
 * Unraid FUSE storage check. Runs once per boot inside the supervised image and
 * reports which data volumes sit on a FUSE mount, plus where shfs says the files live.
 */

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { promisify } from 'node:util';
import type { StorageMountIssue, StorageMountKey, StorageWarning } from '@tracearr/shared';

const execFileAsync = promisify(execFile);

const LOCATIONS_TIMEOUT_MS = 2000;

const TARGETS: { key: StorageMountKey; path: string }[] = [
  { key: 'postgres', path: '/data/postgres' },
  { key: 'redis', path: '/data/redis' },
  { key: 'appData', path: '/data/tracearr' },
];

export interface Mount {
  mountPoint: string;
  root: string;
  fsType: string;
}

export interface StorageCheckDeps {
  readFile: (path: string) => Promise<string>;
  isDirectory: (path: string) => Promise<boolean>;
  getLocations: (dir: string) => Promise<string>;
}

const defaultDeps: StorageCheckDeps = {
  readFile: (path) => readFile(path, 'utf8'),
  isDirectory: (path) =>
    stat(path).then(
      (stats) => stats.isDirectory(),
      () => false
    ),
  getLocations: async (dir) =>
    (
      await execFileAsync('getfattr', ['-n', 'system.LOCATIONS', '--only-values', dir], {
        timeout: LOCATIONS_TIMEOUT_MS,
      })
    ).stdout,
};

const bootId = randomUUID();
let result: Pick<StorageWarning, 'applicable' | 'issues'> = { applicable: false, issues: [] };
let dismissed = false;

function unescapeMountField(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(parseInt(octal, 8))
  );
}

/** Format: id parent major:minor root mountPoint options [optional...] - fsType source superOptions */
export function parseMountinfo(text: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.split('\n')) {
    const fields = line.trim().split(/\s+/);
    const separator = fields.indexOf('-', 6);
    const root = fields[3];
    const mountPoint = fields[4];
    const fsType = fields[separator + 1];
    if (separator < 0 || !root || !mountPoint || !fsType) continue;
    mounts.push({
      mountPoint: unescapeMountField(mountPoint),
      root: unescapeMountField(root),
      fsType,
    });
  }
  return mounts;
}

/** Longest mount point containing the path; a later mount on the same point shadows an earlier one. */
export function mountFor(mounts: Mount[], path: string): Mount | undefined {
  let best: Mount | undefined;
  for (const mount of mounts) {
    const mp = mount.mountPoint;
    const contains = mp === '/' || path === mp || path.startsWith(mp + '/');
    if (contains && (!best || mp.length >= best.mountPoint.length)) best = mount;
  }
  return best;
}

export function classifyLocations(
  raw: string | null,
  root: string
): StorageMountIssue['placement'] {
  if (raw === null) return { kind: 'unknown' };
  const names = raw.trim().split(',');
  if (!names.every((name) => /^[a-z0-9_-]+$/.test(name))) return { kind: 'unknown' };
  const only = names[0];
  if (only && names.length === 1 && !/^disk\d+$/.test(only)) {
    return { kind: 'pool', pool: only, newPath: posix.join('/mnt', only, root) };
  }
  return { kind: 'split', disks: names };
}

function withinTimeout<T>(promise: Promise<T>): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), LOCATIONS_TIMEOUT_MS);
  });
  return Promise.race([promise.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

async function checkTarget(
  deps: StorageCheckDeps,
  mounts: Mount[],
  key: StorageMountKey,
  path: string
): Promise<StorageMountIssue | null> {
  const mount = mountFor(mounts, path);
  if (!mount?.fsType.startsWith('fuse.')) return null;
  if (mount.fsType !== 'fuse.shfs') {
    return { key, fsType: mount.fsType, currentPath: null, placement: { kind: 'unknown' } };
  }
  const root = posix.join(mount.root, path.slice(mount.mountPoint.length));
  const raw = await withinTimeout(deps.getLocations(path));
  return {
    key,
    fsType: mount.fsType,
    currentPath: posix.join('/mnt/user', root),
    placement: classifyLocations(raw, root),
  };
}

export async function runStorageCheck(deps: StorageCheckDeps = defaultDeps): Promise<void> {
  try {
    // Only the supervised image creates /data/postgres. PG_VERSION inside it is unreadable
    // here: the directory is 0700 postgres and Node runs as tracearr.
    if (!(await deps.isDirectory('/data/postgres'))) {
      result = { applicable: false, issues: [] };
      return;
    }
    const mounts = parseMountinfo(await deps.readFile('/proc/self/mountinfo'));
    const checked = await Promise.all(
      TARGETS.map(({ key, path }) => checkTarget(deps, mounts, key, path))
    );
    result = { applicable: true, issues: checked.filter((issue) => issue !== null) };
  } catch (err) {
    console.warn('[StorageCheck] could not read mounts:', err);
  }
}

export function getStorageWarning(): StorageWarning {
  return { ...result, bootId, dismissed };
}

export function dismissStorageWarning(): void {
  dismissed = true;
}
