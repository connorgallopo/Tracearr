import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { BASE_PATH } from '@/lib/basePath';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  ActiveSession,
  ViolationWithDetails,
  DashboardStats,
  NotificationEventType,
  NotificationToast,
  LibrarySyncProgress,
  TautulliImportProgress,
  JellystatImportProgress,
  MaintenanceJobProgress,
  RunningTask,
  ServerConnectionStatus,
} from '@tracearr/shared';
import { WS_EVENTS } from '@tracearr/shared';
import { useAuth } from './useAuth';
import { useMaintenanceMode } from './useMaintenanceMode';
import { toast } from 'sonner';
import { useDestinations } from './queries';
import { DESTINATIONS_KEY } from './queries/useDestinations';
import { REQUESTS_KEY } from './queries/useRequests';
import { RUNS_KEY } from './queries/useRuns';
import { api } from '@/lib/api';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface UnhealthyServer {
  serverId: string;
  serverName: string;
  since: Date;
}

interface SocketContextValue {
  socket: TypedSocket | null;
  isConnected: boolean;
  subscribeSessions: () => void;
  unsubscribeSessions: () => void;
  unhealthyServers: UnhealthyServer[];
  serverConnectionStatuses: Map<string, ServerConnectionStatus>;
}

const SocketContext = createContext<SocketContextValue | null>(null);

// session:updated fires once per active session per poll tick; trailing-edge
// throttle so a busy tick doesn't trigger a refetch per session.
const SESSION_UPDATED_THROTTLE_MS = 2000;
const SESSION_STOPPED_HISTORY_THROTTLE_MS = 5000;
// Job progress events arrive per batch during syncs/imports; a long import
// would otherwise drive /tasks/running refetches for hours, so this stays
// near the old fixed poll cadence.
const TASKS_REFRESH_THROTTLE_MS = 5000;
// One session start can finish a run per automation, so the burst collapses
// into a single refetch of the run list.
const RUNS_REFRESH_THROTTLE_MS = 2000;

export function SocketProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation(['notifications', 'common']);
  const { isAuthenticated } = useAuth();
  const { isInMaintenance } = useMaintenanceMode();
  const queryClient = useQueryClient();
  const [socket, setSocket] = useState<TypedSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);
  const [unhealthyServers, setUnhealthyServers] = useState<UnhealthyServer[]>([]);
  const [serverConnectionStatuses, setServerConnectionStatuses] = useState<
    Map<string, ServerConnectionStatus>
  >(new Map());

  // Browser-toast preferences live on the web_toast destination. Gated on auth -
  // this provider mounts globally, and an unauthenticated fetch would 401 on the
  // login page.
  const { data: destinations } = useDestinations(isAuthenticated);

  const webToastEventsRef = useRef<Set<string> | null>(null);
  const sessionUpdatedThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionStoppedHistoryThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tasksRefreshThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const runsRefreshThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasConnectedRef = useRef(false);

  useEffect(() => {
    const row = destinations?.find((d) => d.type === 'web_toast');
    webToastEventsRef.current = row ? new Set(row.enabled ? row.events : []) : null;
  }, [destinations]);

  // null means not loaded or not readable (non-owners get a 403): toast anyway, as before.
  // Only violations still subscribe; every other toast comes from an automation.
  const isWebToastEnabled = useCallback((eventType: NotificationEventType): boolean => {
    const events = webToastEventsRef.current;
    return events ? events.has(eventType) : true;
  }, []);

  // Fetch initial server health status on authentication
  useEffect(() => {
    if (!isAuthenticated) {
      setUnhealthyServers([]);
      return;
    }

    api.servers
      .health()
      .then((servers) => {
        setUnhealthyServers(servers.map((s) => ({ ...s, since: new Date() })));
      })
      .catch(() => {
        // Ignore errors - health check is best-effort
      });
  }, [isAuthenticated]);

  // Fetch initial connection statuses on authentication
  useEffect(() => {
    if (!isAuthenticated) {
      setServerConnectionStatuses(new Map());
      return;
    }

    api.servers
      .connectionStatus()
      .then((statuses) => {
        const map = new Map<string, ServerConnectionStatus>();
        for (const s of statuses) map.set(s.serverId, s);
        setServerConnectionStatuses(map);
      })
      .catch(() => {
        // Best-effort, no impact on core functionality
      });
  }, [isAuthenticated]);

  useEffect(() => {
    // Nothing to connect to while the server is starting up (Socket.IO attaches
    // after services init), and a fresh handshake is wanted once it's back.
    // A merely unreachable server is left to socket.io's own reconnect loop.
    if (!isAuthenticated || isInMaintenance) {
      setSocket(null);
      setIsConnected(false);
      return;
    }

    // Session cookie rides the handshake via withCredentials. Reconnection is
    // left at the library defaults: unlimited attempts, 1s-5s jittered backoff.
    const newSocket: TypedSocket = io({
      path: `${BASE_PATH}/socket.io`,
      withCredentials: true,
    });

    const scheduleTasksRefresh = () => {
      if (tasksRefreshThrottleRef.current) return;
      tasksRefreshThrottleRef.current = setTimeout(() => {
        tasksRefreshThrottleRef.current = null;
        void queryClient.invalidateQueries({ queryKey: ['tasks', 'running'] });
      }, TASKS_REFRESH_THROTTLE_MS);
    };

    newSocket.on('connect', () => {
      setIsConnected(true);
      // Catch up on anything missed while the socket was down. Skipped on the
      // very first connect (queries are fresh) and when the server recovered
      // the session and replayed the gap itself.
      if (hasConnectedRef.current && !newSocket.recovered) {
        void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
        void queryClient.invalidateQueries({ queryKey: ['tasks', 'running'] });
        void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      }
      hasConnectedRef.current = true;
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
    });

    newSocket.on('connect_error', (error) => {
      console.error('[Socket] Connection error:', error);
    });

    // Handle real-time events
    // Note: Since users can filter by server, we invalidate all matching query patterns
    // and let react-query refetch with the appropriate server filter
    newSocket.on(WS_EVENTS.SESSION_STARTED, (_session: ActiveSession) => {
      // Invalidate all active sessions queries (regardless of server filter)
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      // Invalidate dashboard stats and session history
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });
    });

    newSocket.on(WS_EVENTS.SESSION_STOPPED, (_sessionId: string) => {
      // Invalidate all active sessions queries (regardless of server filter)
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      // Invalidate dashboard stats and session history (stopped session now has duration)
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });

      if (!sessionStoppedHistoryThrottleRef.current) {
        sessionStoppedHistoryThrottleRef.current = setTimeout(() => {
          sessionStoppedHistoryThrottleRef.current = null;
          void queryClient.invalidateQueries({ queryKey: ['sessions', 'history'] });
        }, SESSION_STOPPED_HISTORY_THROTTLE_MS);
      }
    });

    newSocket.on(WS_EVENTS.SESSION_UPDATED, (_session: ActiveSession) => {
      if (sessionUpdatedThrottleRef.current) return;
      sessionUpdatedThrottleRef.current = setTimeout(() => {
        sessionUpdatedThrottleRef.current = null;
        void queryClient.invalidateQueries({ queryKey: ['sessions', 'active'] });
      }, SESSION_UPDATED_THROTTLE_MS);
    });

    newSocket.on(WS_EVENTS.VIOLATION_NEW, (violation: ViolationWithDetails) => {
      // Invalidate violations query
      void queryClient.invalidateQueries({ queryKey: ['violations'] });
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });

      // Show toast notification if web notifications are enabled for violation_detected
      if (isWebToastEnabled('violation_detected')) {
        const toastFn = violation.severity === 'high' ? toast.error : toast.warning;
        toastFn(
          t('notifications:toast.info.violationDetected.title', { ruleName: violation.rule.name }),
          {
            description: t('notifications:toast.info.violationDetected.message', {
              user: violation.user.identityName ?? violation.user.username,
              ruleType: violation.rule.type,
            }),
          }
        );
      }
    });

    newSocket.on(WS_EVENTS.RUN_FINISHED, () => {
      if (runsRefreshThrottleRef.current) return;
      runsRefreshThrottleRef.current = setTimeout(() => {
        runsRefreshThrottleRef.current = null;
        void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
      }, RUNS_REFRESH_THROTTLE_MS);
    });

    newSocket.on(WS_EVENTS.STATS_UPDATED, (_stats: DashboardStats) => {
      // Invalidate all dashboard stats queries (they now have server-specific cache keys)
      void queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
    });

    newSocket.on(
      WS_EVENTS.VERSION_UPDATE,
      (data: { current: string; latest: string; releaseUrl: string }) => {
        // Invalidate version query to refresh update status
        void queryClient.invalidateQueries({ queryKey: ['version'] });

        // Show toast notification for new version
        toast.info(t('notifications:toast.info.updateAvailable.title'), {
          description: t('notifications:toast.info.updateAvailable.message', {
            version: data.latest,
          }),
          action: {
            label: t('common:actions.view'),
            onClick: () => window.open(data.releaseUrl, '_blank'),
          },
          duration: 10000,
        });
      }
    );

    newSocket.on(WS_EVENTS.SERVER_DOWN, (data: { serverId: string; serverName: string }) => {
      // Track unhealthy server for persistent banner
      setUnhealthyServers((prev) => {
        // Avoid duplicates
        if (prev.some((s) => s.serverId === data.serverId)) return prev;
        return [...prev, { ...data, since: new Date() }];
      });
    });

    newSocket.on(WS_EVENTS.SERVER_UP, (data: { serverId: string; serverName: string }) => {
      // Remove from unhealthy servers
      setUnhealthyServers((prev) => prev.filter((s) => s.serverId !== data.serverId));
    });

    // Stream and server toasts arrive here too: the automation choosing the web_toast row is the gate.
    newSocket.on(WS_EVENTS.NOTIFICATION_TOAST, (data: NotificationToast) => {
      const toastFn =
        data.severity === 'high'
          ? toast.error
          : data.severity === 'warning'
            ? toast.warning
            : toast.info;
      toastFn(data.title, { description: data.message, duration: 10000 });
    });

    // Any instance's destination write lands here, including the toast preferences read above.
    newSocket.on(WS_EVENTS.DESTINATIONS_CHANGED, () => {
      void queryClient.invalidateQueries({ queryKey: DESTINATIONS_KEY });
    });

    newSocket.on(WS_EVENTS.REQUESTS_CHANGED, () => {
      void queryClient.invalidateQueries({ queryKey: REQUESTS_KEY });
    });

    // A server added, renamed, reordered or removed anywhere; the builder's
    // server list comes from the filter options, so refresh both.
    newSocket.on(WS_EVENTS.SERVERS_CHANGED, () => {
      void queryClient.invalidateQueries({ queryKey: ['servers'] });
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'filter-options'] });
    });

    newSocket.on(WS_EVENTS.SERVER_CONNECTION, (status: ServerConnectionStatus) => {
      setServerConnectionStatuses((prev) => {
        const next = new Map(prev);
        next.set(status.serverId, status);
        return next;
      });
    });

    // Unified running-tasks push; the server does not emit this yet, but the
    // shared contract defines it, so honor it if it ever arrives.
    newSocket.on(WS_EVENTS.TASKS_UPDATED, (tasks: RunningTask[]) => {
      queryClient.setQueryData(['tasks', 'running'], { tasks });
    });

    // Library sync progress - invalidate library caches when sync completes
    newSocket.on(WS_EVENTS.LIBRARY_SYNC_PROGRESS, (progress: LibrarySyncProgress) => {
      scheduleTasksRefresh();
      if (progress.status === 'complete' || progress.status === 'error') {
        // Invalidate all library queries to refresh storage and stale content
        void queryClient.invalidateQueries({ queryKey: ['library'] });
        void queryClient.invalidateQueries({ queryKey: ['media'] });
      }
    });

    // Tautulli import progress - invalidate session data when import completes
    newSocket.on(WS_EVENTS.IMPORT_PROGRESS, (progress: TautulliImportProgress) => {
      scheduleTasksRefresh();
      if (progress.status === 'complete') {
        // Invalidate session history and stats after importing watch history
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        void queryClient.invalidateQueries({ queryKey: ['stats'] });
        void queryClient.invalidateQueries({ queryKey: ['users'] });
      }
    });

    // Jellystat import progress - invalidate session data when import completes
    newSocket.on(WS_EVENTS.IMPORT_JELLYSTAT_PROGRESS, (progress: JellystatImportProgress) => {
      scheduleTasksRefresh();
      if (progress.status === 'complete') {
        // Invalidate session history and stats after importing watch history
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        void queryClient.invalidateQueries({ queryKey: ['stats'] });
        void queryClient.invalidateQueries({ queryKey: ['users'] });
      }
    });

    // Maintenance job progress - invalidate relevant caches when jobs complete
    newSocket.on(WS_EVENTS.MAINTENANCE_PROGRESS, (progress: MaintenanceJobProgress) => {
      scheduleTasksRefresh();
      if (progress.status === 'complete') {
        // Different jobs affect different data
        switch (progress.type) {
          case 'rebuild_timescale_views':
            // Rebuilding views affects all chart/stats data
            void queryClient.invalidateQueries({ queryKey: ['library'] });
            void queryClient.invalidateQueries({ queryKey: ['media'] });
            void queryClient.invalidateQueries({ queryKey: ['stats'] });
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
            break;
          case 'normalize_players':
          case 'normalize_codecs':
            // These affect session/playback data
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
            void queryClient.invalidateQueries({ queryKey: ['library'] });
            void queryClient.invalidateQueries({ queryKey: ['media'] });
            break;
          case 'normalize_countries':
            // Affects geographic data in sessions
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
            break;
          case 'fix_imported_progress':
            // Affects session progress data
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
            void queryClient.invalidateQueries({ queryKey: ['stats'] });
            break;
          case 'backfill_user_dates':
            // Affects user data
            void queryClient.invalidateQueries({ queryKey: ['users'] });
            break;
          default:
            // Unknown job type - invalidate common caches as fallback
            void queryClient.invalidateQueries({ queryKey: ['sessions'] });
            void queryClient.invalidateQueries({ queryKey: ['stats'] });
            break;
        }
      }
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
      if (sessionUpdatedThrottleRef.current) {
        clearTimeout(sessionUpdatedThrottleRef.current);
        sessionUpdatedThrottleRef.current = null;
      }
      if (sessionStoppedHistoryThrottleRef.current) {
        clearTimeout(sessionStoppedHistoryThrottleRef.current);
        sessionStoppedHistoryThrottleRef.current = null;
      }
      if (tasksRefreshThrottleRef.current) {
        clearTimeout(tasksRefreshThrottleRef.current);
        tasksRefreshThrottleRef.current = null;
      }
      if (runsRefreshThrottleRef.current) {
        clearTimeout(runsRefreshThrottleRef.current);
        runsRefreshThrottleRef.current = null;
      }
    };
  }, [isAuthenticated, isInMaintenance, queryClient, isWebToastEnabled]);

  const subscribeSessions = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('subscribe:sessions');
    }
  }, [socket, isConnected]);

  const unsubscribeSessions = useCallback(() => {
    if (socket && isConnected) {
      socket.emit('unsubscribe:sessions');
    }
  }, [socket, isConnected]);

  const value = useMemo<SocketContextValue>(
    () => ({
      socket,
      isConnected,
      subscribeSessions,
      unsubscribeSessions,
      unhealthyServers,
      serverConnectionStatuses,
    }),
    [
      socket,
      isConnected,
      subscribeSessions,
      unsubscribeSessions,
      unhealthyServers,
      serverConnectionStatuses,
    ]
  );

  return <SocketContext.Provider value={value}>{children}</SocketContext.Provider>;
}

export function useSocket(): SocketContextValue {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
