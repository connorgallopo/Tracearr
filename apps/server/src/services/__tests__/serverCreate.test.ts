import { beforeEach, describe, expect, it, vi } from 'vitest';

const { calls, step } = vi.hoisted(() => {
  const calls: string[] = [];
  const step =
    (name: string) =>
    async (..._args: unknown[]): Promise<unknown> => {
      calls.push(name);
      return undefined;
    };
  return { calls, step };
});

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn(), insert: vi.fn(), transaction: vi.fn() },
}));
vi.mock('../../jobs/importQueue.js', () => ({
  holdServerHistoryImport: vi.fn(step('holdImport')),
}));
vi.mock('../../jobs/poller/database.js', () => ({
  publishServersChanged: vi.fn(step('publishServersChanged')),
}));
vi.mock('../../jobs/librarySyncQueue.js', () => ({
  enqueueLibrarySync: vi.fn(step('librarySync')),
  markFirstSyncOwed: vi.fn(step('markFirstSyncOwed')),
  rebuildAutoSyncSchedules: vi.fn(step('rebuildAutoSyncSchedules')),
}));
vi.mock('../../jobs/requestSyncQueue.js', () => ({
  scheduleRequestSync: vi.fn(step('scheduleRequestSync')),
  enqueueRequestSync: vi.fn(step('requestSync')),
}));
vi.mock('../requests/store.js', () => ({ addBuiltInRequestServices: vi.fn() }));
vi.mock('../settings.js', () => ({ rearmImportedHistoryLink: vi.fn(step('rearm')) }));
vi.mock('../sseManager.js', () => ({ sseManager: { refresh: vi.fn(step('sseRefresh')) } }));
vi.mock('../sync.js', () => ({ syncServer: vi.fn() }));

import type { SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { holdServerHistoryImport } from '../../jobs/importQueue.js';
import { enqueueLibrarySync } from '../../jobs/librarySyncQueue.js';
import { renderSql } from '../../test/helpers.js';
import {
  connectedServerConflict,
  createServer,
  startAddedServer,
  syncReconnectedServer,
} from '../serverCreate.js';
import { syncServer } from '../sync.js';

const usersSynced = { usersAdded: 2, usersRead: true, errors: [] as string[] };
const tofa = { id: 'srv-1', type: 'tofa' as const };

async function settled(last: string): Promise<void> {
  await vi.waitFor(() => expect(calls).toContain(last));
}

beforeEach(() => {
  calls.length = 0;
  vi.mocked(syncServer).mockImplementation(async () => {
    calls.push('userSync');
    return usersSynced as never;
  });
});

describe('startAddedServer', () => {
  it('holds the history import and marks the first sync owed, then syncs users, queues the library sync and syncs requests', async () => {
    await startAddedServer(tofa, ['service-1']);
    await settled('requestSync');

    expect(calls).toEqual([
      'publishServersChanged',
      'rebuildAutoSyncSchedules',
      'holdImport',
      'markFirstSyncOwed',
      'sseRefresh',
      'userSync',
      'librarySync',
      'scheduleRequestSync',
      'requestSync',
    ]);
    expect(holdServerHistoryImport).toHaveBeenCalledExactlyOnceWith('srv-1', 'tofa');
    expect(syncServer).toHaveBeenCalledWith('srv-1', { syncUsers: true, syncLibraries: false });
    expect(enqueueLibrarySync).toHaveBeenCalledWith('srv-1', 'event', { firstSync: true });
  });

  it("holds a Silo server's own history import", async () => {
    await startAddedServer({ id: 'srv-3', type: 'silo' }, []);
    await settled('librarySync');

    expect(holdServerHistoryImport).toHaveBeenCalledExactlyOnceWith('srv-3', 'silo');
    expect(calls.indexOf('holdImport')).toBeLessThan(calls.indexOf('markFirstSyncOwed'));
  });

  it('re-arms imported history linking for Plex and holds no import', async () => {
    await startAddedServer({ id: 'srv-2', type: 'plex' }, []);
    await settled('librarySync');

    expect(calls).toContain('rearm');
    expect(calls).not.toContain('holdImport');
  });

  it('keeps the request sync when the user list was read with errors on some users', async () => {
    vi.mocked(syncServer).mockImplementation(async () => {
      calls.push('userSync');
      return { ...usersSynced, errors: ['Failed to sync user sam: timeout'] } as never;
    });

    await startAddedServer(tofa, ['service-1']);
    await settled('requestSync');

    expect(calls.slice(-4)).toEqual([
      'userSync',
      'librarySync',
      'scheduleRequestSync',
      'requestSync',
    ]);
  });

  it('schedules the request sync but runs none when the user list could not be read', async () => {
    vi.mocked(syncServer).mockImplementation(async () => {
      calls.push('userSync');
      return {
        ...usersSynced,
        usersRead: false,
        errors: ['tofa user sync failed: unreachable'],
      } as never;
    });

    await startAddedServer(tofa, ['service-1']);
    await settled('scheduleRequestSync');

    expect(calls.slice(-3)).toEqual(['userSync', 'librarySync', 'scheduleRequestSync']);
    expect(calls).not.toContain('requestSync');
  });
});

describe('syncReconnectedServer', () => {
  it('syncs users, then queues a library sync that is not a first sync, and restarts nothing', async () => {
    syncReconnectedServer('srv-3');
    await settled('librarySync');

    expect(calls).toEqual(['userSync', 'librarySync']);
    expect(enqueueLibrarySync).toHaveBeenCalledWith('srv-3', 'event', { firstSync: false });
  });
});

describe('connectedServerConflict', () => {
  function connected(rows: { url: string }[]) {
    const where = vi.fn().mockReturnThis();
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where,
      limit: vi.fn().mockResolvedValue(rows),
    } as never);
    return where;
  }

  it('names the address when a server is connected there', async () => {
    connected([{ url: 'http://silo.lan:8090' }]);
    expect(await connectedServerConflict('silo', 'http://silo.lan:8090', 'silo-1')).toBe('url');
  });

  it('names the identity when a server of the same type reports the same id elsewhere', async () => {
    const where = connected([{ url: 'http://192.168.1.20:8090' }]);

    expect(await connectedServerConflict('silo', 'http://silo.lan:8090', 'silo-1')).toBe(
      'identity'
    );
    const condition = renderSql(where.mock.calls[0]?.[0] as SQL);
    expect(condition.sql).toContain('type =');
    expect(condition.sql).toContain('machine_identifier =');
    expect(condition.params).toEqual(expect.arrayContaining(['silo', 'silo-1']));
  });

  it('finds nothing to refuse, and checks only the address without an identity', async () => {
    const where = connected([]);

    expect(await connectedServerConflict('silo', 'http://silo.lan:8090', null)).toBeNull();
    expect(renderSql(where.mock.calls[0]?.[0] as SQL).sql).not.toContain('machine_identifier');
  });
});

describe('createServer', () => {
  it('stores the id of a key Tracearr made', async () => {
    vi.mocked(db.select).mockReturnValueOnce({ from: vi.fn().mockResolvedValue([]) } as never);
    const values = vi.fn().mockReturnThis();
    vi.mocked(db.insert).mockReturnValue({
      values,
      returning: vi.fn().mockResolvedValue([{ id: 'srv-4', type: 'silo' }]),
    } as never);
    vi.mocked(db.transaction).mockImplementation(async (fn: unknown) =>
      (fn as (tx: typeof db) => Promise<unknown>)(db)
    );

    await createServer({
      name: 'Silo',
      type: 'silo',
      url: 'http://silo.lan:8090',
      token: 'silo-key',
      apiKeyId: 'key-1',
      facts: {},
    });

    expect(values).toHaveBeenCalledWith(expect.objectContaining({ apiKeyId: 'key-1' }));
  });
});
