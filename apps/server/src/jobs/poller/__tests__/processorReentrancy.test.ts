/**
 * Reentrancy Guard Tests
 *
 * triggerReconciliationPoll and triggerServerPoll can both be invoked from
 * multiple concurrent triggers (the 30s reconciliation timer, an SSE
 * reconnect, and the SSE-plugin debounce timer respectively). These tests
 * verify a second concurrent call is skipped while the first is in flight.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbSelect = vi.fn();
const { mockCreateMediaServerClient, mockGetActiveAutomations } = vi.hoisted(() => ({
  mockCreateMediaServerClient: vi.fn(),
  mockGetActiveAutomations: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../../db/client.js', () => ({
  db: { select: (...args: unknown[]) => mockDbSelect(...args) },
}));

vi.mock('../../../services/leaderLease.js', () => ({
  isLeader: () => true,
}));

vi.mock('../../../db/schema.js', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual };
});

vi.mock('../../../routes/settings.js', () => ({
  getGeoIPSettings: vi.fn().mockResolvedValue({ usePlexGeoip: false }),
}));

vi.mock('../../../services/settings.js', () => ({
  getWatchedThreshold: vi.fn().mockResolvedValue(0.85),
}));

vi.mock('../../../serverState.js', () => ({
  isMaintenance: vi.fn().mockReturnValue(false),
}));

vi.mock('../../../services/mediaServer/index.js', () => ({
  createMediaServerClient: mockCreateMediaServerClient,
}));

vi.mock('../../../services/plexGeoip.js', () => ({
  lookupGeoIP: vi.fn().mockResolvedValue({ city: null, country: null }),
}));

vi.mock('../../../services/serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

vi.mock('../../../services/sseManager.js', () => ({
  sseManager: {
    isInFallback: vi.fn().mockReturnValue(false),
    nudgeReconnect: vi.fn(),
  },
}));

vi.mock('../../notificationQueue.js', () => ({
  enqueueNotification: vi.fn(),
}));

vi.mock('../database.js', () => ({
  getCachedServers: () => mockDbSelect().from(),
  getActiveAutomations: mockGetActiveAutomations,
  batchGetIdentityServerUserIds: vi.fn().mockResolvedValue(new Map()),
  batchGetLibraryItemIdentity: vi.fn().mockResolvedValue(new Map()),
  batchGetRecentUserSessions: vi.fn().mockResolvedValue(new Map()),
  widenRecentSessionsForMergedIdentities: vi.fn(),
}));

vi.mock('../pendingConfirmation.js', () => ({
  updatePendingSession: vi.fn(),
}));

vi.mock('../sessionLifecycle.js', () => ({
  batchFindActiveSessionsByComposite: vi.fn().mockResolvedValue(new Map()),
  batchFindActiveSessionsByKey: vi.fn().mockResolvedValue(new Map()),
  buildActiveSession: vi.fn(),
  buildPendingActiveSession: vi.fn(),
  createSessionWithRulesAtomic: vi.fn(),
  findActiveSession: vi.fn(),
  findActiveSessionByComposite: vi.fn(),
  handleMediaChangeAtomic: vi.fn(),
  processPollResults: vi.fn().mockResolvedValue(undefined),
  stopSessionAtomic: vi.fn(),
}));

const mockDispatch = vi.fn().mockResolvedValue({ violations: [], outcomes: [] });
vi.mock('../../../services/automations/events/dispatcher.js', () => ({
  dispatch: (...args: unknown[]) => mockDispatch(...args),
  subscribe: vi.fn(),
}));

vi.mock('../violations.js', () => ({
  broadcastViolations: vi.fn(),
}));

import { triggerReconciliationPoll, triggerServerPoll } from '../processor.js';
import { fakePlexClient } from '../../../test/mediaServerFakes.js';
import type { MediaSession } from '../../../services/mediaServer/types.js';

/** Deferred promise helper for controlling when a mocked async call resolves. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * Thenable query-chain stub for `db.select().from(servers)`. Awaiting the
 * `from()` result directly (triggerReconciliationPoll's unfiltered fetch)
 * resolves to `allRows`; chaining `.where()` (triggerServerPoll's per-server
 * fetch) resolves to `whereRows`.
 */
function chainResolving(allRows: unknown[], whereRows: unknown[] = allRows) {
  const obj: Record<string, unknown> = {};
  obj.where = () => Promise.resolve(whereRows);
  obj.then = (resolve: (v: unknown[]) => void, reject?: (e: unknown) => void) =>
    Promise.resolve(allRows).then(resolve, reject);
  obj.catch = (reject: (e: unknown) => void) => Promise.resolve(allRows).catch(reject);
  return obj;
}

describe('reentrancy guards', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('triggerReconciliationPoll', () => {
    it('skips a second concurrent call while the first is still in flight', async () => {
      const gate = deferred<unknown[]>();
      mockDbSelect.mockReturnValue({ from: () => gate.promise });

      const first = triggerReconciliationPoll();
      const second = triggerReconciliationPoll();

      // The second call returns without ever touching the db, since the
      // guard check happens synchronously before any await in the function.
      await second;
      expect(mockDbSelect).toHaveBeenCalledTimes(1);

      gate.resolve([]);
      await first;
    });

    it('allows a new run once the previous one has finished', async () => {
      mockDbSelect.mockReturnValue({ from: () => Promise.resolve([]) });

      await triggerReconciliationPoll();
      await triggerReconciliationPoll();

      expect(mockDbSelect).toHaveBeenCalledTimes(2);
    });
  });

  describe('triggerServerPoll', () => {
    it('skips a second concurrent call for the same server while one is in flight', async () => {
      const gate = deferred<unknown[]>();
      mockDbSelect.mockReturnValue({ from: () => ({ where: () => gate.promise }) });

      const first = triggerServerPoll('server-1');
      const second = triggerServerPoll('server-1');

      await second;
      expect(mockDbSelect).toHaveBeenCalledTimes(1);

      gate.resolve([]);
      await first;
    });

    it('does not block concurrent calls for a different server', async () => {
      const gateA = deferred<unknown[]>();
      const gateB = deferred<unknown[]>();
      let call = 0;
      mockDbSelect.mockImplementation(() => {
        call++;
        const gate = call === 1 ? gateA : gateB;
        return { from: () => ({ where: () => gate.promise }) };
      });

      const first = triggerServerPoll('server-1');
      const second = triggerServerPoll('server-2');

      gateA.resolve([]);
      gateB.resolve([]);
      await Promise.all([first, second]);

      expect(mockDbSelect).toHaveBeenCalledTimes(2);
    });
  });
});

/**
 * These tests exercise the shared per-server lock directly: triggerServerPoll
 * and triggerReconciliationPoll are different entry points but must not run
 * processServerSessions for the same server at the same time, since both
 * read and mutate the module-level missedPollTracking grace-period map.
 */
describe('cross-entry-point server lock', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const serverRow1 = {
    id: 'server-1',
    name: 'Server 1',
    type: 'plex',
    url: 'http://localhost:32400',
    token: 'token-1',
  };
  const serverRow2 = {
    id: 'server-2',
    name: 'Server 2',
    type: 'plex',
    url: 'http://localhost:32401',
    token: 'token-2',
  };

  it('skips a server in triggerReconciliationPoll while triggerServerPoll is still processing it', async () => {
    mockDbSelect.mockReturnValue({ from: () => chainResolving([serverRow1]) });
    const gate = deferred<MediaSession[]>();
    mockCreateMediaServerClient.mockReturnValue(
      fakePlexClient({ getSessions: () => gate.promise })
    );

    const first = triggerServerPoll('server-1');
    await vi.waitFor(() => expect(mockCreateMediaServerClient).toHaveBeenCalledTimes(1));

    const second = triggerReconciliationPoll();
    await second;

    // Reconciliation must have skipped server-1 outright - it never reached
    // processServerSessions for it, so the media client was not called again.
    expect(mockCreateMediaServerClient).toHaveBeenCalledTimes(1);

    gate.resolve([]);
    await first;
  });

  it('does not block a different server: triggerReconciliationPoll still processes server-2', async () => {
    mockDbSelect.mockReturnValue({
      from: () => chainResolving([serverRow1, serverRow2], [serverRow1]),
    });
    const gate1 = deferred<MediaSession[]>();
    const gate2 = deferred<MediaSession[]>();
    let call = 0;
    mockCreateMediaServerClient.mockImplementation(() => {
      call++;
      return fakePlexClient({ getSessions: () => (call === 1 ? gate1.promise : gate2.promise) });
    });

    const first = triggerServerPoll('server-1');
    await vi.waitFor(() => expect(mockCreateMediaServerClient).toHaveBeenCalledTimes(1));

    const second = triggerReconciliationPoll();

    gate1.resolve([]);
    gate2.resolve([]);
    await Promise.all([first, second]);

    // One call for triggerServerPoll's server-1, one for reconciliation's
    // server-2 - server-1 is never processed twice.
    expect(mockCreateMediaServerClient).toHaveBeenCalledTimes(2);
  });

  it('releases the lock when a run throws, so a later run for the same server still executes', async () => {
    mockDbSelect.mockReturnValue({ from: () => chainResolving([serverRow1]) });
    mockGetActiveAutomations.mockRejectedValueOnce(new Error('boom'));

    await triggerServerPoll('server-1');
    expect(mockDbSelect).toHaveBeenCalledTimes(1);

    // If the throw had left the lock held, this second call would skip and
    // never touch the db.
    await triggerServerPoll('server-1');
    expect(mockDbSelect).toHaveBeenCalledTimes(2);
  });
});
