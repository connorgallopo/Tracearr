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

vi.mock('../../db/client.js', () => ({ db: {} }));
vi.mock('../../jobs/importQueue.js', () => ({ holdTofaImport: vi.fn(step('holdImport')) }));
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

import { enqueueLibrarySync } from '../../jobs/librarySyncQueue.js';
import { startAddedServer, syncReconnectedServer } from '../serverCreate.js';
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
    expect(syncServer).toHaveBeenCalledWith('srv-1', { syncUsers: true, syncLibraries: false });
    expect(enqueueLibrarySync).toHaveBeenCalledWith('srv-1', 'event', { firstSync: true });
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
