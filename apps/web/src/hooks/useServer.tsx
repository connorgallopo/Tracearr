import {
  createContext,
  useContext,
  useState,
  useCallback,
  useMemo,
  useEffect,
  type ReactNode,
} from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Server } from '@tracearr/shared';
import { api } from '@/lib/api';
import { useAuth } from './useAuth';

// Local storage key for persisting selected server
const SELECTED_SERVER_KEY = 'tracearr_selected_server';

interface ServerContextValue {
  servers: Server[];
  selectedServer: Server | null;
  selectedServerId: string | null;
  isLoading: boolean;
  isFetching: boolean;
  selectServer: (serverId: string) => void;
  refetch: () => Promise<unknown>;
}

const ServerContext = createContext<ServerContextValue | null>(null);

export function ServerProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();
  const [selectedServerId, setSelectedServerId] = useState<string | null>(() => {
    // Initialize from localStorage
    return localStorage.getItem(SELECTED_SERVER_KEY);
  });

  // Fetch available servers (only when authenticated)
  const {
    data: servers = [],
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ['servers'],
    queryFn: () => api.servers.list(),
    enabled: isAuthenticated,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // Filter servers by user's accessible serverIds (non-owners only see assigned servers)
  const accessibleServers = useMemo(() => {
    if (!user) return [];
    if (user.role === 'owner') return servers;
    return servers.filter((s) => user.serverIds.includes(s.id));
  }, [servers, user]);

  // Validate and auto-select server when servers load
  useEffect(() => {
    // Don't do anything while still loading servers or waiting for user data
    // This prevents clearing selection before we have the full picture
    if (isLoading || !user) {
      return;
    }

    if (accessibleServers.length === 0) {
      // No servers available after loading, clear selection
      if (selectedServerId) {
        setSelectedServerId(null);
        localStorage.removeItem(SELECTED_SERVER_KEY);
      }
      return;
    }

    // If selected server is not in accessible list, select first available
    const currentServerValid =
      selectedServerId && accessibleServers.some((s) => s.id === selectedServerId);
    if (!currentServerValid) {
      const firstServer = accessibleServers[0];
      if (firstServer) {
        setSelectedServerId(firstServer.id);
        localStorage.setItem(SELECTED_SERVER_KEY, firstServer.id);
      }
    }
  }, [accessibleServers, selectedServerId, isLoading, user]);

  // Clear selection on logout
  useEffect(() => {
    if (!isAuthenticated) {
      setSelectedServerId(null);
      localStorage.removeItem(SELECTED_SERVER_KEY);
    }
  }, [isAuthenticated]);

  const selectServer = useCallback(
    (serverId: string) => {
      setSelectedServerId(serverId);
      localStorage.setItem(SELECTED_SERVER_KEY, serverId);
      // Invalidate server-dependent queries to force refetch with new server context
      // We exclude 'servers' query as that's not server-dependent
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          // Keep server list, invalidate everything else that may be server-specific
          return key !== 'servers';
        },
      });
    },
    [queryClient]
  );

  // Get the full server object for the selected ID
  const selectedServer = useMemo(() => {
    if (!selectedServerId) return null;
    return accessibleServers.find((s) => s.id === selectedServerId) ?? null;
  }, [accessibleServers, selectedServerId]);

  const value = useMemo<ServerContextValue>(
    () => ({
      servers: accessibleServers,
      selectedServer,
      selectedServerId,
      isLoading,
      isFetching,
      selectServer,
      refetch,
    }),
    [
      accessibleServers,
      selectedServer,
      selectedServerId,
      isLoading,
      isFetching,
      selectServer,
      refetch,
    ]
  );

  return <ServerContext.Provider value={value}>{children}</ServerContext.Provider>;
}

export function useServer(): ServerContextValue {
  const context = useContext(ServerContext);
  if (!context) {
    throw new Error('useServer must be used within a ServerProvider');
  }
  return context;
}

// Convenience hook to get just the selected server ID (common use case)
export function useSelectedServerId(): string | null {
  const { selectedServerId } = useServer();
  return selectedServerId;
}
