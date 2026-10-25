import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  classifyLocations,
  dismissStorageWarning,
  getStorageWarning,
  mountFor,
  parseMountinfo,
  runStorageCheck,
} from '../storageCheck.js';

const ROOT_LINE = '900 1 0:40 / / rw,relatime - overlay overlay rw,lowerdir=/x';
const PG_FUSE =
  '1000 900 0:52 /appdata/tracearr/postgres /data/postgres rw,relatime - fuse.shfs shfs rw,user_id=0';
const REDIS_BTRFS =
  '1001 900 259:1 /appdata/tracearr/redis /data/redis rw - btrfs /dev/nvme0n1p1 rw';
const APP_BTRFS =
  '1002 900 259:1 /appdata/tracearr/app /data/tracearr rw - btrfs /dev/nvme0n1p1 rw';

function deps(mountinfo: string[], getLocations: (dir: string) => Promise<string>) {
  return {
    readFile: async () => mountinfo.join('\n') + '\n',
    isDirectory: async (path: string) => path === '/data/postgres',
    getLocations,
  };
}

describe('storage check', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('detects a fuse.shfs mount and rebuilds the host path', async () => {
    await runStorageCheck(deps([ROOT_LINE, PG_FUSE, REDIS_BTRFS, APP_BTRFS], async () => 'cache'));
    const warning = getStorageWarning();
    expect(warning.applicable).toBe(true);
    expect(warning.issues).toHaveLength(1);
    expect(warning.issues[0]).toMatchObject({
      key: 'postgres',
      fsType: 'fuse.shfs',
      currentPath: '/mnt/user/appdata/tracearr/postgres',
    });
  });

  it('treats a btrfs mount as fine', async () => {
    const pgBtrfs =
      '1000 900 259:1 /appdata/tracearr/postgres /data/postgres rw - btrfs /dev/nvme0n1p1 rw';
    await runStorageCheck(deps([ROOT_LINE, pgBtrfs, REDIS_BTRFS, APP_BTRFS], async () => 'cache'));
    expect(getStorageWarning()).toMatchObject({ applicable: true, issues: [] });
  });

  it('decodes \\040 in mount points', () => {
    const mounts = parseMountinfo(
      '1003 900 0:52 /app\\040data/tracearr /data/app\\040data rw - fuse.shfs shfs rw'
    );
    expect(mountFor(mounts, '/data/app data')).toMatchObject({
      mountPoint: '/data/app data',
      root: '/app data/tracearr',
      fsType: 'fuse.shfs',
    });
  });

  it('matches the longest mount prefix', async () => {
    const lines = [
      ROOT_LINE,
      '1000 900 259:1 /appdata/tracearr/postgres /data/postgres rw - btrfs /dev/nvme0n1p1 rw',
      REDIS_BTRFS,
      '1004 900 0:52 /appdata/tracearr/app /data/tracearr rw - fuse.shfs shfs rw',
      '1005 900 8:17 /image-cache /data/tracearr/image-cache rw - xfs /dev/md1p1 rw',
    ];
    await runStorageCheck(deps(lines, async () => 'cache'));
    const issues = getStorageWarning().issues;
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      key: 'appData',
      fsType: 'fuse.shfs',
      currentPath: '/mnt/user/appdata/tracearr/app',
    });
  });

  it('classifies one pool as movable', () => {
    expect(classifyLocations('cache\n', '/appdata/tracearr/postgres')).toEqual({
      kind: 'pool',
      pool: 'cache',
      newPath: '/mnt/cache/appdata/tracearr/postgres',
    });
  });

  it('classifies a custom pool name', () => {
    expect(classifyLocations('fastpool', '/appdata/tracearr/postgres')).toEqual({
      kind: 'pool',
      pool: 'fastpool',
      newPath: '/mnt/fastpool/appdata/tracearr/postgres',
    });
  });

  it('classifies a split folder', () => {
    expect(classifyLocations('cache,disk1,disk2', '/appdata/tracearr/postgres')).toEqual({
      kind: 'split',
      disks: ['cache', 'disk1', 'disk2'],
    });
  });

  it.each(['cache,', ',cache', 'DISK1', 'cache\0'])(
    'treats a malformed location list %j as unknown',
    (raw) => {
      expect(classifyLocations(raw, '/appdata/tracearr/postgres')).toEqual({ kind: 'unknown' });
    }
  );

  it('classifies array only as split', () => {
    expect(classifyLocations('disk3', '/appdata/tracearr/postgres')).toEqual({
      kind: 'split',
      disks: ['disk3'],
    });
  });

  it('falls back to unknown when getfattr fails', async () => {
    await runStorageCheck(
      deps([ROOT_LINE, PG_FUSE, REDIS_BTRFS, APP_BTRFS], () =>
        Promise.reject(new Error('getfattr: not found'))
      )
    );
    expect(getStorageWarning().issues[0]?.placement).toEqual({ kind: 'unknown' });
  });

  it('falls back to unknown when getfattr hangs', async () => {
    vi.useFakeTimers();
    const done = runStorageCheck(
      deps([ROOT_LINE, PG_FUSE, REDIS_BTRFS, APP_BTRFS], () => new Promise<string>(() => {}))
    );
    await vi.advanceTimersByTimeAsync(2000);
    await done;
    expect(getStorageWarning().issues[0]?.placement).toEqual({ kind: 'unknown' });
  });

  it('is not applicable without a postgres data directory', async () => {
    await runStorageCheck({
      ...deps([ROOT_LINE, PG_FUSE], async () => 'cache'),
      isDirectory: async () => false,
    });
    const warning = getStorageWarning();
    expect(warning.applicable).toBe(false);
    expect(warning.issues).toEqual([]);
  });

  it('reports unknown placement for non-shfs fuse', async () => {
    const getLocations = vi.fn(async () => 'cache');
    await runStorageCheck(
      deps(
        [
          ROOT_LINE,
          '1000 900 0:60 /tracearr/postgres /data/postgres rw - fuse.mergerfs pool rw',
          REDIS_BTRFS,
          APP_BTRFS,
        ],
        getLocations
      )
    );
    expect(getStorageWarning().issues[0]).toEqual({
      key: 'postgres',
      fsType: 'fuse.mergerfs',
      currentPath: null,
      placement: { kind: 'unknown' },
    });
    expect(getLocations).not.toHaveBeenCalled();
  });

  it('dismiss hides until the boot id changes', async () => {
    const before = getStorageWarning();
    expect(before.dismissed).toBe(false);
    dismissStorageWarning();
    expect(getStorageWarning()).toMatchObject({ dismissed: true, bootId: before.bootId });

    vi.resetModules();
    const fresh = await import('../storageCheck.js');
    const next = fresh.getStorageWarning();
    expect(next.dismissed).toBe(false);
    expect(next.bootId).not.toBe(before.bootId);
  });
});
