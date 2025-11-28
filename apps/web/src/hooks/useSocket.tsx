import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  type ReactNode,
} from 'react';
import { io, type Socket } from 'socket.io-client';
import { useQueryClient } from '@tanstack/react-query';
import type {
  ServerToClientEvents,
  ClientToServerEvents,
  ActiveSession,
  ViolationWithDetails,
  DashboardStats,
} from '@tracearr/shared';
import { WS_EVENTS } from '@tracearr/shared';
import { useAuth } from './useAuth';
import { useToast } from './use-toast';

type TypedSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

interface SocketContextValue {
  socket: TypedSocket | null;
  isConnected: boolean;
  subscribeSessions: () => void;
  unsubscribeSessions: () => void;
}

const SocketContext = createContext<SocketContextValue | null>(null);

export function SocketProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [socket, setSocket] = useState<TypedSocket | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    if (!isAuthenticated) {
      if (socket) {
        socket.disconnect();
        setSocket(null);
        setIsConnected(false);
      }
      return;
    }

    // Create socket connection
    const newSocket: TypedSocket = io({
      path: '/socket.io',
      withCredentials: true,
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    newSocket.on('connect', () => {
      setIsConnected(true);
      console.log('[Socket] Connected');
    });

    newSocket.on('disconnect', () => {
      setIsConnected(false);
      console.log('[Socket] Disconnected');
    });

    newSocket.on('connect_error', (error) => {
      console.error('[Socket] Connection error:', error);
    });

    // Handle real-time events
    newSocket.on(WS_EVENTS.SESSION_STARTED as 'session:started', (session: ActiveSession) => {
      // Update active sessions query
      queryClient.setQueryData<ActiveSession[]>(['sessions', 'active'], (old) => {
        if (!old) return [session];
        return [...old, session];
      });

      // Invalidate dashboard stats
      queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });

      toast({
        title: 'New Stream Started',
        description: `${session.user.username} is watching ${session.mediaTitle}`,
      });
    });

    newSocket.on(WS_EVENTS.SESSION_STOPPED as 'session:stopped', (sessionId: string) => {
      // Remove from active sessions
      queryClient.setQueryData<ActiveSession[]>(['sessions', 'active'], (old) => {
        if (!old) return [];
        return old.filter((s) => s.id !== sessionId);
      });

      // Invalidate dashboard stats
      queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });
    });

    newSocket.on(WS_EVENTS.SESSION_UPDATED as 'session:updated', (session: ActiveSession) => {
      // Update session in active sessions
      queryClient.setQueryData<ActiveSession[]>(['sessions', 'active'], (old) => {
        if (!old) return [session];
        return old.map((s) => (s.id === session.id ? session : s));
      });
    });

    newSocket.on(WS_EVENTS.VIOLATION_NEW as 'violation:new', (violation: ViolationWithDetails) => {
      // Invalidate violations query
      queryClient.invalidateQueries({ queryKey: ['violations'] });
      queryClient.invalidateQueries({ queryKey: ['stats', 'dashboard'] });

      // Show toast notification
      const severityColors = {
        low: 'default',
        warning: 'default',
        high: 'destructive',
      } as const;

      toast({
        title: `New Violation: ${violation.rule.name}`,
        description: `${violation.user.username} triggered ${violation.rule.type}`,
        variant: severityColors[violation.severity],
      });
    });

    newSocket.on(WS_EVENTS.STATS_UPDATED as 'stats:updated', (stats: DashboardStats) => {
      // Update dashboard stats directly
      queryClient.setQueryData(['stats', 'dashboard'], stats);
    });

    setSocket(newSocket);

    return () => {
      newSocket.disconnect();
    };
  }, [isAuthenticated, queryClient, toast]);

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
    }),
    [socket, isConnected, subscribeSessions, unsubscribeSessions]
  );

  return (
    <SocketContext.Provider value={value}>{children}</SocketContext.Provider>
  );
}

export function useSocket(): SocketContextValue {
  const context = useContext(SocketContext);
  if (!context) {
    throw new Error('useSocket must be used within a SocketProvider');
  }
  return context;
}
