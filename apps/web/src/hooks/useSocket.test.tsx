import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const fake = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const webToast = {
    id: 'web-toast',
    name: 'Browser toast',
    type: 'web_toast',
    enabled: true,
    builtin: true,
    events: ['violation_detected'] as string[],
    configStatus: 'ok',
    config: null,
    secretsSet: [],
    referencedByAutomationCount: 0,
    referencedByNewsletterCount: 0,
    createdAt: '2026-08-17T00:00:00.000Z',
    updatedAt: '2026-08-17T00:00:00.000Z',
  };
  const socket = {
    recovered: false,
    on: vi.fn((event: string, cb: (...args: unknown[]) => void) => {
      handlers.set(event, cb);
      return socket;
    }),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
  return {
    socket,
    handlers,
    webToast,
    io: vi.fn((_opts?: Record<string, unknown>) => socket),
    auth: { isAuthenticated: true },
    maintenance: { isInMaintenance: false, isUnreachable: false },
    destinations: { data: [webToast] as unknown[] | undefined },
  };
});

vi.mock('socket.io-client', () => ({ io: fake.io }));
vi.mock('./useAuth', () => ({ useAuth: () => fake.auth }));
vi.mock('./useMaintenanceMode', () => ({ useMaintenanceMode: () => fake.maintenance }));
vi.mock('./queries', () => ({ useDestinations: () => fake.destinations }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('sonner', () => ({
  toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/api', () => ({
  api: {
    servers: {
      health: vi.fn().mockResolvedValue([]),
      connectionStatus: vi.fn().mockResolvedValue([]),
    },
  },
}));

import { WS_EVENTS } from '@tracearr/shared';
import { toast } from 'sonner';
import { DESTINATIONS_KEY } from './queries/useDestinations';
import { RUNS_KEY } from './queries/useRuns';
import { SocketProvider, useSocket } from './useSocket';

const startedSession = {
  user: { identityName: 'alice', username: 'alice' },
  mediaTitle: 'Arrival',
};

const violation = {
  severity: 'warning',
  rule: { name: 'Concurrent streams', type: null },
  user: { identityName: 'alice', username: 'alice' },
};

function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries').mockResolvedValue();
  function wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <SocketProvider>{children}</SocketProvider>
      </QueryClientProvider>
    );
  }
  const view = renderHook(() => useSocket(), { wrapper });
  return { ...view, invalidate };
}

function fire(event: string, ...args: unknown[]) {
  act(() => {
    fake.handlers.get(event)?.(...args);
  });
}

describe('SocketProvider', () => {
  beforeEach(() => {
    fake.io.mockClear();
    fake.socket.on.mockClear();
    fake.socket.disconnect.mockClear();
    fake.socket.recovered = false;
    fake.handlers.clear();
    fake.auth.isAuthenticated = true;
    fake.maintenance.isInMaintenance = false;
    fake.maintenance.isUnreachable = false;
    fake.webToast.enabled = true;
    fake.webToast.events = ['violation_detected'];
    fake.destinations.data = [fake.webToast];
    vi.mocked(toast.info).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.warning).mockClear();
    vi.mocked(toast.success).mockClear();
  });

  it('lets socket.io keep retrying instead of capping reconnection attempts', () => {
    setup();
    const opts = fake.io.mock.calls[0]?.[0];
    expect(opts).toBeDefined();
    expect(opts?.reconnectionAttempts).toBeUndefined();
  });

  it('keeps the socket while the server is merely unreachable', () => {
    const { rerender } = setup();
    fake.maintenance.isUnreachable = true;
    rerender();

    expect(fake.io).toHaveBeenCalledTimes(1);
    expect(fake.socket.disconnect).not.toHaveBeenCalled();
  });

  it('tears the socket down when the server reports maintenance', () => {
    const { rerender } = setup();
    fake.maintenance.isInMaintenance = true;
    rerender();

    expect(fake.socket.disconnect).toHaveBeenCalledTimes(1);
  });

  it('refetches after a plain reconnect but not after a recovered one', () => {
    const { invalidate } = setup();
    fire('connect');
    expect(invalidate).not.toHaveBeenCalled();

    fire('disconnect');
    fire('connect');
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'active'] });

    invalidate.mockClear();
    fake.socket.recovered = true;
    fire('disconnect');
    fire('connect');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('leaves stream and server toasts to the automation that asked for them', () => {
    setup();
    fire(WS_EVENTS.SESSION_STARTED, startedSession);
    fire(WS_EVENTS.SESSION_STOPPED, 'sess-1');
    fire(WS_EVENTS.SERVER_DOWN, { serverId: 's1', serverName: 'Plex' });
    fire(WS_EVENTS.SERVER_UP, { serverId: 's1', serverName: 'Plex' });

    expect(toast.info).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('still tracks the unhealthy server behind the banner', () => {
    const { result } = setup();
    fire(WS_EVENTS.SERVER_DOWN, { serverId: 's1', serverName: 'Plex' });

    expect(result.current.unhealthyServers.map((s) => s.serverId)).toEqual(['s1']);

    fire(WS_EVENTS.SERVER_UP, { serverId: 's1', serverName: 'Plex' });
    expect(result.current.unhealthyServers).toEqual([]);
  });

  it('keeps gating the violation toast on the web_toast subscription', () => {
    fake.webToast.events = ['violation_detected'];
    setup();
    fire(WS_EVENTS.VIOLATION_NEW, violation);

    expect(toast.warning).toHaveBeenCalled();
  });

  it('stays quiet for a violation the web_toast row does not subscribe to', () => {
    fake.webToast.events = [];
    setup();
    fire(WS_EVENTS.VIOLATION_NEW, violation);

    expect(toast.warning).not.toHaveBeenCalled();
  });

  it('toasts a violation by default while the destinations query has no data', () => {
    fake.destinations.data = undefined;
    setup();
    fire(WS_EVENTS.VIOLATION_NEW, violation);

    expect(toast.warning).toHaveBeenCalled();
  });

  it('refetches the destination list when another instance changes one', () => {
    const { invalidate } = setup();
    fire(WS_EVENTS.DESTINATIONS_CHANGED);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: DESTINATIONS_KEY });
  });

  it('refetches servers and filter options when a server changes', () => {
    const { invalidate } = setup();
    fire(WS_EVENTS.SERVERS_CHANGED);

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['servers'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sessions', 'filter-options'] });
  });

  it('coalesces a burst of finished runs into one refetch', () => {
    vi.useFakeTimers();
    try {
      const { invalidate } = setup();

      for (let i = 0; i < 19; i++) fire(WS_EVENTS.RUN_FINISHED);
      expect(invalidate).not.toHaveBeenCalledWith({ queryKey: RUNS_KEY });

      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(invalidate).toHaveBeenCalledWith({ queryKey: RUNS_KEY });
      expect(invalidate.mock.calls.filter(([args]) => args?.queryKey === RUNS_KEY)).toHaveLength(1);

      fire(WS_EVENTS.RUN_FINISHED);
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(invalidate.mock.calls.filter(([args]) => args?.queryKey === RUNS_KEY)).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders a rule toast from the notification payload', () => {
    setup();
    fire(WS_EVENTS.NOTIFICATION_TOAST, {
      title: 'Rule tripped',
      message: 'alice is streaming from two places',
      ruleId: 'r1',
      ruleName: 'Concurrent streams',
      severity: 'high',
    });

    expect(toast.error).toHaveBeenCalledWith('Rule tripped', {
      description: 'alice is streaming from two places',
      duration: 10000,
    });
  });
});
