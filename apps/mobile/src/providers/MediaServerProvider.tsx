/**
 * Media Server selection provider
 * Fetches available servers from Tracearr API and manages selection
 * Similar to web's useServer hook
 */
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
import * as SecureStore from 'expo-secure-store';
import type { Server } from '@tracearr/shared';
import { api } from '../lib/api';
import { useAuthStore } from '../lib/authStore';

const SELECTED_SERVER_KEY = 'tracearr_selected_media_server';

interface MediaServerContextValue {
  servers: Server[];
  selectedServer: Server | null;
  selectedServerId: string | null;
  isLoading: boolean;
  selectServer: (serverId: string | null) => void;
  refetch: () => Promise<unknown>;
}

const MediaServerContext = createContext<MediaServerContextValue | null>(null);

export function MediaServerProvider({ children }: { children: ReactNode }) {
  const { isAuthenticated, activeServerId: tracearrBackendId } = useAuthStore();
  const queryClient = useQueryClient();
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);

  // Load saved selection on mount
  useEffect(() => {
    void SecureStore.getItemAsync(SELECTED_SERVER_KEY).then((saved) => {
      if (saved) {
        setSelectedServerId(saved);
      }
      setInitialized(true);
    });
  }, []);

  // Fetch available servers from API
  const {
    data: servers = [],
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ['media-servers', tracearrBackendId],
    queryFn: () => api.servers.list(),
    enabled: isAuthenticated && !!tracearrBackendId,
    staleTime: 1000 * 60 * 5, // 5 minutes
  });

  // Validate selection when servers load
  useEffect(() => {
    if (!initialized || isLoading) return;

    if (servers.length === 0) {
      if (selectedServerId) {
        setSelectedServerId(null);
        void SecureStore.deleteItemAsync(SELECTED_SERVER_KEY);
      }
      return;
    }

    // If selection is invalid (server no longer exists), select first
    if (selectedServerId && !servers.some((s) => s.id === selectedServerId)) {
      const firstServer = servers[0];
      if (firstServer) {
        setSelectedServerId(firstServer.id);
        void SecureStore.setItemAsync(SELECTED_SERVER_KEY, firstServer.id);
      }
    }

    // If no selection but servers exist, select first
    if (!selectedServerId && servers.length > 0) {
      const firstServer = servers[0];
      if (firstServer) {
        setSelectedServerId(firstServer.id);
        void SecureStore.setItemAsync(SELECTED_SERVER_KEY, firstServer.id);
      }
    }
  }, [servers, selectedServerId, initialized, isLoading]);

  // Clear selection on logout
  useEffect(() => {
    if (!isAuthenticated) {
      setSelectedServerId(null);
      void SecureStore.deleteItemAsync(SELECTED_SERVER_KEY);
    }
  }, [isAuthenticated]);

  const selectServer = useCallback(
    (serverId: string | null) => {
      setSelectedServerId(serverId);
      if (serverId) {
        void SecureStore.setItemAsync(SELECTED_SERVER_KEY, serverId);
      } else {
        void SecureStore.deleteItemAsync(SELECTED_SERVER_KEY);
      }
      // Invalidate all server-dependent queries
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const key = query.queryKey[0];
          return key !== 'media-servers' && key !== 'servers';
        },
      });
    },
    [queryClient]
  );

  const selectedServer = useMemo(() => {
    if (!selectedServerId) return null;
    return servers.find((s) => s.id === selectedServerId) ?? null;
  }, [servers, selectedServerId]);

  const value = useMemo<MediaServerContextValue>(
    () => ({
      servers,
      selectedServer,
      selectedServerId,
      isLoading,
      selectServer,
      refetch,
    }),
    [servers, selectedServer, selectedServerId, isLoading, selectServer, refetch]
  );

  return <MediaServerContext.Provider value={value}>{children}</MediaServerContext.Provider>;
}

export function useMediaServer(): MediaServerContextValue {
  const context = useContext(MediaServerContext);
  if (!context) {
    throw new Error('useMediaServer must be used within a MediaServerProvider');
  }
  return context;
}

export function useSelectedServerId(): string | null {
  const { selectedServerId } = useMediaServer();
  return selectedServerId;
}
