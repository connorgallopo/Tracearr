import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../db/client.js', () => ({
  db: { select: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue([]) }) },
}));

const { mockLiveServers } = vi.hoisted(() => ({ mockLiveServers: vi.fn() }));
vi.mock('../liveServers.js', () => ({
  liveServers: (...args: unknown[]) => mockLiveServers(...args),
}));

vi.mock('../../websocket/index.js', () => ({
  broadcastToSessions: vi.fn(),
}));

vi.mock('../../jobs/poller/index.js', () => ({
  triggerServerPoll: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../jobs/librarySyncQueue.js', () => ({
  enqueueLibrarySyncForChange: vi.fn().mockResolvedValue(undefined),
}));

// Mock the event sources so addServer() doesn't open real network connections.
// Must use regular functions (not arrows) so `new` works.
vi.mock('../mediaServer/plex/eventSource.js', () => ({
  PlexEventSource: vi.fn(function () {
    return {
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn(),
      retryFromFallback: vi.fn(),
      getStatus: vi.fn().mockReturnValue({
        serverId: 'plex-1',
        serverName: 'Plex Server',
        state: 'connected',
        connectedAt: new Date('2026-01-01T00:00:00Z'),
        lastEventAt: null,
        reconnectAttempts: 0,
        error: null,
      }),
    };
  }),
}));

vi.mock('../mediaServer/shared/jellyfinEmbyEventSource.js', () => ({
  JellyfinEmbyEventSource: vi.fn(function () {
    return {
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn(),
      retryFromFallback: vi.fn(),
      getStatus: vi.fn().mockReturnValue({
        serverId: 'jf-1',
        serverName: 'Jellyfin Server',
        state: 'connected',
        connectedAt: new Date('2026-01-01T00:00:00Z'),
        lastEventAt: null,
        reconnectAttempts: 0,
        error: null,
      }),
    };
  }),
}));

vi.mock('../mediaServer/tofa/eventSource.js', () => ({
  TofaEventSource: vi.fn(function () {
    return {
      on: vi.fn(),
      connect: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(),
      removeAllListeners: vi.fn(),
      retryFromFallback: vi.fn(),
      getStatus: vi.fn().mockReturnValue({
        serverId: 'tofa-1',
        serverName: 'tofa',
        state: 'connected',
        connectedAt: new Date('2026-01-01T00:00:00Z'),
        lastEventAt: null,
        reconnectAttempts: 0,
        error: null,
      }),
    };
  }),
}));

vi.mock('../serviceTracker.js', () => ({
  registerService: vi.fn(),
  unregisterService: vi.fn(),
}));

vi.mock('../leaderLease.js', () => ({
  isLeader: vi.fn().mockReturnValue(true),
}));

import { SSEManager } from '../sseManager.js';
import { PlexEventSource } from '../mediaServer/plex/eventSource.js';
import { TofaEventSource } from '../mediaServer/tofa/eventSource.js';
import { enqueueLibrarySyncForChange } from '../../jobs/librarySyncQueue.js';
import { triggerServerPoll } from '../../jobs/poller/index.js';
import type { CacheService, PubSubService } from '../cache.js';

interface PrivateManager {
  refreshConnectionStatuses: () => void;
  startReconciliation: () => void;
}

interface PrivateManagerInternals {
  connections: Map<string, { state: string }>;
  lastNudgeAt: Map<string, number>;
  handleConnectionStateChange: (
    serverId: string,
    serverName: string,
    state: string,
    status: {
      serverId: string;
      serverName: string;
      state: string;
      connectedAt: Date | null;
      lastEventAt: Date | null;
      reconnectAttempts: number;
      error: string | null;
    }
  ) => void;
}

function makeCacheService(): CacheService {
  return {
    setServerConnectionStatus: vi.fn().mockResolvedValue(undefined),
    getServerConnectionStatus: vi.fn().mockResolvedValue(null),
  } as unknown as CacheService;
}

function makePubSubService(): PubSubService {
  return {} as unknown as PubSubService;
}

describe('SSEManager.refreshConnectionStatuses', () => {
  let manager: SSEManager;
  let cache: CacheService;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = new SSEManager();
    cache = makeCacheService();
  });

  afterEach(async () => {
    await manager.stop();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('writes mode=realtime to Redis for a connected Jellyfin server', async () => {
    await manager.initialize(cache, makePubSubService());
    await manager.addServer('jf-1', 'Jellyfin Server', 'jellyfin', 'http://jf.local', 'token');

    vi.mocked(cache.setServerConnectionStatus).mockClear();

    // Drive the private refresh directly - this is what the reconciliation timer calls
    (manager as unknown as PrivateManager).refreshConnectionStatuses();

    expect(cache.setServerConnectionStatus).toHaveBeenCalledOnce();
    expect(cache.setServerConnectionStatus).toHaveBeenCalledWith(
      'jf-1',
      expect.objectContaining({
        serverId: 'jf-1',
        mode: 'realtime',
        state: 'connected',
      })
    );
  });

  it('does not call broadcastToSessions during the periodic refresh', async () => {
    const { broadcastToSessions } = await import('../../websocket/index.js');

    await manager.initialize(cache, makePubSubService());
    await manager.addServer('jf-1', 'Jellyfin Server', 'jellyfin', 'http://jf.local', 'token');

    vi.mocked(broadcastToSessions).mockClear();

    (manager as unknown as PrivateManager).refreshConnectionStatuses();

    expect(broadcastToSessions).not.toHaveBeenCalled();
  });

  it('skips refresh gracefully when no cacheService is set', () => {
    // Do NOT call initialize() - cacheService stays null; must not throw
    expect(() => {
      (manager as unknown as PrivateManager).refreshConnectionStatuses();
    }).not.toThrow();
  });

  it('catches and logs write failures without stopping the loop', async () => {
    await manager.initialize(cache, makePubSubService());
    await manager.addServer('jf-1', 'Jellyfin Server', 'jellyfin', 'http://jf.local', 'token');

    vi.mocked(cache.setServerConnectionStatus).mockRejectedValue(new Error('Redis down'));

    expect(() => {
      (manager as unknown as PrivateManager).refreshConnectionStatuses();
    }).not.toThrow();

    await vi.runAllTimersAsync();
  });

  it('calls refreshConnectionStatuses on the reconciliation interval', async () => {
    await manager.initialize(cache, makePubSubService());
    await manager.addServer('jf-1', 'Jellyfin Server', 'jellyfin', 'http://jf.local', 'token');

    vi.mocked(cache.setServerConnectionStatus).mockClear();

    (manager as unknown as PrivateManager).startReconciliation();

    await vi.advanceTimersByTimeAsync(30_001);

    expect(cache.setServerConnectionStatus).toHaveBeenCalledWith(
      'jf-1',
      expect.objectContaining({ mode: 'realtime', state: 'connected' })
    );
  });
});

describe('SSEManager.addServer', () => {
  let manager: SSEManager;
  let cache: CacheService;

  beforeEach(() => {
    manager = new SSEManager();
    cache = makeCacheService();
  });

  afterEach(async () => {
    await manager.stop();
    vi.clearAllMocks();
  });

  it('disconnects and clears listeners on the eventSource when connect() throws', async () => {
    const disconnect = vi.fn();
    const removeAllListeners = vi.fn();
    vi.mocked(PlexEventSource).mockImplementationOnce(function () {
      return {
        on: vi.fn(),
        connect: vi.fn().mockRejectedValue(new Error('connect failed')),
        disconnect,
        removeAllListeners,
        retryFromFallback: vi.fn(),
        getStatus: vi.fn(),
      } as unknown as InstanceType<typeof PlexEventSource>;
    });

    await manager.initialize(cache, makePubSubService());

    await expect(
      manager.addServer('plex-1', 'Plex Server', 'plex', 'http://plex.local', 'token')
    ).rejects.toThrow('connect failed');

    expect(removeAllListeners).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledOnce();
    // Failed connect must never leave a tracked connection behind
    expect(manager.getStatus()).toEqual([]);
  });

  it('does not leak pendingOperations tracking after a failed connect, so retry can proceed', async () => {
    vi.mocked(PlexEventSource).mockImplementationOnce(function () {
      return {
        on: vi.fn(),
        connect: vi.fn().mockRejectedValue(new Error('connect failed')),
        disconnect: vi.fn(),
        removeAllListeners: vi.fn(),
        retryFromFallback: vi.fn(),
        getStatus: vi.fn(),
      } as unknown as InstanceType<typeof PlexEventSource>;
    });

    await manager.initialize(cache, makePubSubService());

    await expect(
      manager.addServer('plex-1', 'Plex Server', 'plex', 'http://plex.local', 'token')
    ).rejects.toThrow('connect failed');

    // A retry with a working connect() must succeed - a stuck pendingOperations
    // entry from the failed attempt would silently no-op this call instead.
    await manager.addServer('plex-1', 'Plex Server', 'plex', 'http://plex.local', 'token');
    expect(manager.getStatus()).toHaveLength(1);
  });
});

describe('SSEManager.removeServer', () => {
  let manager: SSEManager;
  let cache: CacheService;

  beforeEach(() => {
    manager = new SSEManager();
    cache = makeCacheService();
  });

  afterEach(async () => {
    await manager.stop();
    vi.clearAllMocks();
  });

  it('prunes lastNudgeAt so a re-added server with the same id is not rate-limited by stale state', async () => {
    await manager.initialize(cache, makePubSubService());
    await manager.addServer('jf-1', 'Jellyfin Server', 'jellyfin', 'http://jf.local', 'token');

    const internals = manager as unknown as PrivateManagerInternals;
    internals.handleConnectionStateChange('jf-1', 'Jellyfin Server', 'fallback', {
      serverId: 'jf-1',
      serverName: 'Jellyfin Server',
      state: 'fallback',
      connectedAt: null,
      lastEventAt: null,
      reconnectAttempts: 0,
      error: null,
    });

    manager.nudgeReconnect('jf-1');
    expect(internals.lastNudgeAt.has('jf-1')).toBe(true);

    await manager.removeServer('jf-1');

    expect(internals.lastNudgeAt.has('jf-1')).toBe(false);
  });
});

describe('SSEManager.nudgeReconnect', () => {
  let manager: SSEManager;
  let cache: CacheService;

  beforeEach(() => {
    manager = new SSEManager();
    cache = makeCacheService();
  });

  afterEach(async () => {
    await manager.stop();
    vi.clearAllMocks();
  });

  function fakeStatus(state: string) {
    return {
      serverId: 'jf-1',
      serverName: 'Jellyfin Server',
      state,
      connectedAt: null,
      lastEventAt: null,
      reconnectAttempts: 0,
      error: null,
    };
  }

  it('retries an unsupported server so a wrong 404 verdict heals on poll success', async () => {
    await manager.initialize(cache, makePubSubService());
    await manager.addServer('jf-1', 'Jellyfin Server', 'jellyfin', 'http://jf.local', 'token');

    const internals = manager as unknown as PrivateManagerInternals;
    internals.handleConnectionStateChange(
      'jf-1',
      'Jellyfin Server',
      'unsupported',
      fakeStatus('unsupported')
    );

    manager.nudgeReconnect('jf-1');

    const { JellyfinEmbyEventSource } =
      await import('../mediaServer/shared/jellyfinEmbyEventSource.js');
    const instance = vi.mocked(JellyfinEmbyEventSource).mock.results[0]?.value as {
      retryFromFallback: ReturnType<typeof vi.fn>;
    };
    expect(instance.retryFromFallback).toHaveBeenCalledTimes(1);
  });

  it('does not retry a connected server', async () => {
    await manager.initialize(cache, makePubSubService());
    await manager.addServer('jf-1', 'Jellyfin Server', 'jellyfin', 'http://jf.local', 'token');

    const internals = manager as unknown as PrivateManagerInternals;
    internals.handleConnectionStateChange(
      'jf-1',
      'Jellyfin Server',
      'connected',
      fakeStatus('connected')
    );

    manager.nudgeReconnect('jf-1');

    const { JellyfinEmbyEventSource } =
      await import('../mediaServer/shared/jellyfinEmbyEventSource.js');
    const instance = vi.mocked(JellyfinEmbyEventSource).mock.results[0]?.value as {
      retryFromFallback: ReturnType<typeof vi.fn>;
    };
    expect(instance.retryFromFallback).not.toHaveBeenCalled();
  });
});

describe('SSEManager.refresh', () => {
  let manager: SSEManager;

  /** refresh() reads the live servers through liveServers(). */
  function mockServerRows(rows: unknown[]) {
    mockLiveServers.mockResolvedValue(rows);
  }

  const row = {
    id: 'plex-1',
    name: 'Plex Server',
    type: 'plex' as const,
    url: 'http://plex.local',
    token: 'token-1',
  };

  beforeEach(() => {
    manager = new SSEManager();
  });

  afterEach(async () => {
    await manager.stop();
    vi.clearAllMocks();
  });

  it('connects a server that has no connection yet', async () => {
    await manager.initialize(makeCacheService(), makePubSubService());
    mockServerRows([row]);

    await manager.refresh();

    expect(PlexEventSource).toHaveBeenCalledTimes(1);
    expect(vi.mocked(PlexEventSource).mock.calls[0]![0]).toMatchObject({ token: 'token-1' });
  });

  it('rebuilds a connection whose stored token was rotated', async () => {
    await manager.initialize(makeCacheService(), makePubSubService());
    await manager.addServer(row.id, row.name, row.type, row.url, 'token-1');
    vi.mocked(PlexEventSource).mockClear();

    mockServerRows([{ ...row, token: 'token-2' }]);
    await manager.refresh();

    // A live connection keeps the token it was built with, so the only way the
    // new one reaches Plex is a rebuild.
    expect(PlexEventSource).toHaveBeenCalledTimes(1);
    expect(vi.mocked(PlexEventSource).mock.calls[0]![0]).toMatchObject({ token: 'token-2' });
  });

  it('rebuilds a connection whose url changed', async () => {
    await manager.initialize(makeCacheService(), makePubSubService());
    await manager.addServer(row.id, row.name, row.type, row.url, row.token);
    vi.mocked(PlexEventSource).mockClear();

    mockServerRows([{ ...row, url: 'http://moved.local' }]);
    await manager.refresh();

    expect(vi.mocked(PlexEventSource).mock.calls[0]![0]).toMatchObject({
      url: 'http://moved.local',
    });
  });

  it('leaves a connection alone when url and token both still match', async () => {
    await manager.initialize(makeCacheService(), makePubSubService());
    await manager.addServer(row.id, row.name, row.type, row.url, row.token);
    vi.mocked(PlexEventSource).mockClear();

    mockServerRows([row]);
    await manager.refresh();

    // Reconciliation runs every 30s; rebuilding on every pass would drop the
    // stream continuously.
    expect(PlexEventSource).not.toHaveBeenCalled();
  });

  it('starts connections for the live servers only', async () => {
    await manager.initialize(makeCacheService(), makePubSubService());
    mockServerRows([row]);

    await manager.start();

    expect(mockLiveServers).toHaveBeenCalledTimes(1);
    expect(PlexEventSource).toHaveBeenCalledTimes(1);
  });

  describe('a tofa server', () => {
    const tofa = { ...row, id: 'tofa-1', name: 'tofa', type: 'tofa' as const, token: 'tofa-key' };

    /** The handler the manager registered on the tofa socket for an event */
    function onTofa(event: string): (payload: unknown) => void {
      const source = vi.mocked(TofaEventSource).mock.results[0]?.value as {
        on: ReturnType<typeof vi.fn>;
      };
      const call = source.on.mock.calls.find(([name]) => name === event);
      return call?.[1] as (payload: unknown) => void;
    }

    beforeEach(async () => {
      await manager.initialize(makeCacheService(), makePubSubService());
      mockServerRows([tofa, row]);
      await manager.start();
    });

    it('is polled until its socket connects, then left to the socket', () => {
      expect(vi.mocked(TofaEventSource).mock.calls[0]![0]).toMatchObject({ token: 'tofa-key' });
      expect(manager.getServersNeedingPoll()).toContain('tofa-1');

      onTofa('connection:state')('connected');

      expect(manager.getServersNeedingPoll()).not.toContain('tofa-1');
    });

    it('reads the session list when a session changes', async () => {
      vi.useFakeTimers();
      onTofa('stream')({ kind: 'changed', sessionId: 'session-1' });
      await vi.advanceTimersByTimeAsync(1000);
      vi.useRealTimers();

      expect(triggerServerPoll).toHaveBeenCalledWith('tofa-1');
    });

    it('reconciles at once when the socket says frames were missed', () => {
      onTofa('stream')({ kind: 'missed' });

      expect(triggerServerPoll).toHaveBeenCalledWith('tofa-1');
    });

    it('asks for one delayed library sync for every library change the socket reports', () => {
      onTofa('library:changed')(undefined);
      onTofa('library:changed')(undefined);

      expect(vi.mocked(enqueueLibrarySyncForChange).mock.calls).toEqual([
        ['tofa-1', 60_000],
        ['tofa-1', 60_000],
      ]);
    });

    it('hands a stop with its position to the session processor', () => {
      const stopped = vi.fn();
      manager.on('tofa:session:stopped', stopped);

      onTofa('stream')({
        kind: 'stopped',
        sessionId: 'session-1',
        positionMs: 172476,
        stoppedByAdmin: false,
      });

      expect(stopped).toHaveBeenCalledWith({
        serverId: 'tofa-1',
        sessionId: 'session-1',
        positionMs: 172476,
        stoppedByAdmin: false,
      });
    });
  });

  it('drops the connection of a server that is no longer live', async () => {
    await manager.initialize(makeCacheService(), makePubSubService());
    await manager.addServer(row.id, row.name, row.type, row.url, row.token);

    mockServerRows([]);
    await manager.refresh();

    expect((manager as unknown as PrivateManagerInternals).connections.has('plex-1')).toBe(false);
  });
});
