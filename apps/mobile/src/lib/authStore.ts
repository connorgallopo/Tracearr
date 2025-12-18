/**
 * Authentication state store using Zustand
 * Supports multiple server connections with active server selection
 */
import { create } from 'zustand';
import { storage, type ServerInfo } from './storage';
import { api, resetApiClient } from './api';
import * as Device from 'expo-device';
import { Platform } from 'react-native';
import { isEncryptionAvailable, getDeviceSecret } from './crypto';

interface AuthState {
  // Multi-server state
  servers: ServerInfo[];
  activeServerId: string | null;
  activeServer: ServerInfo | null;

  // Legacy compatibility
  isAuthenticated: boolean;
  isLoading: boolean;
  serverUrl: string | null;
  serverName: string | null;
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  pair: (serverUrl: string, token: string) => Promise<void>;
  addServer: (serverUrl: string, token: string) => Promise<void>;
  removeServer: (serverId: string) => Promise<void>;
  selectServer: (serverId: string) => Promise<void>;
  /** @deprecated Use removeServer(serverId) instead for clarity. This removes the active server. */
  logout: () => Promise<void>;
  removeActiveServer: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  // Initial state
  servers: [],
  activeServerId: null,
  activeServer: null,
  isAuthenticated: false,
  isLoading: true,
  serverUrl: null,
  serverName: null,
  error: null,

  /**
   * Initialize auth state from stored credentials
   * Handles migration from legacy single-server storage
   */
  initialize: async () => {
    try {
      set({ isLoading: true, error: null });

      // Check for and migrate legacy storage
      await storage.migrateFromLegacy();

      // Load servers and active selection
      const servers = await storage.getServers();
      const activeServerId = await storage.getActiveServerId();
      const activeServer = activeServerId
        ? (servers.find((s) => s.id === activeServerId) ?? null)
        : null;

      // If we have servers but no active selection, select first one
      if (servers.length > 0 && !activeServer) {
        const firstServer = servers[0]!;
        await storage.setActiveServerId(firstServer.id);
        set({
          servers,
          activeServerId: firstServer.id,
          activeServer: firstServer,
          isAuthenticated: true,
          serverUrl: firstServer.url,
          serverName: firstServer.name,
          isLoading: false,
        });
      } else if (activeServer) {
        set({
          servers,
          activeServerId,
          activeServer,
          isAuthenticated: true,
          serverUrl: activeServer.url,
          serverName: activeServer.name,
          isLoading: false,
        });
      } else {
        set({
          servers: [],
          activeServerId: null,
          activeServer: null,
          isAuthenticated: false,
          serverUrl: null,
          serverName: null,
          isLoading: false,
        });
      }
    } catch (error) {
      console.error('Auth initialization failed:', error);
      set({
        servers: [],
        activeServerId: null,
        activeServer: null,
        isAuthenticated: false,
        isLoading: false,
        error: 'Failed to initialize authentication',
      });
    }
  },

  /**
   * Pair with server using mobile token (legacy method, adds as first/only server)
   */
  pair: async (serverUrl: string, token: string) => {
    // Delegate to addServer
    await get().addServer(serverUrl, token);
  },

  /**
   * Add a new server connection
   */
  addServer: async (serverUrl: string, token: string) => {
    try {
      set({ isLoading: true, error: null });

      // Get device info
      const deviceName =
        Device.deviceName || `${Device.brand || 'Unknown'} ${Device.modelName || 'Device'}`;
      const deviceId = Device.osBuildId || `${Platform.OS}-${Date.now()}`;
      const platform = Platform.OS === 'ios' ? 'ios' : 'android';

      // Normalize URL (remove trailing slash)
      const normalizedUrl = serverUrl.replace(/\/$/, '');

      // Get device secret for push notification encryption (if available)
      let deviceSecret: string | undefined;
      if (isEncryptionAvailable()) {
        try {
          deviceSecret = await getDeviceSecret();
        } catch (error) {
          console.warn('Failed to get device secret for encryption:', error);
        }
      }

      // Call pair API
      const response = await api.pair(
        normalizedUrl,
        token,
        deviceName,
        deviceId,
        platform,
        deviceSecret
      );

      // Create server info
      const serverInfo: ServerInfo = {
        id: response.server.id,
        url: normalizedUrl,
        name: response.server.name,
        type: response.server.type,
        addedAt: new Date().toISOString(),
      };

      // Store server and credentials
      await storage.addServer(serverInfo, {
        accessToken: response.accessToken,
        refreshToken: response.refreshToken,
      });

      // Set as active server
      await storage.setActiveServerId(serverInfo.id);

      // Reset API client to use new server
      resetApiClient();

      // Update state
      const servers = await storage.getServers();
      set({
        servers,
        activeServerId: serverInfo.id,
        activeServer: serverInfo,
        isAuthenticated: true,
        serverUrl: normalizedUrl,
        serverName: serverInfo.name,
        isLoading: false,
      });
    } catch (error) {
      console.error('Adding server failed:', error);
      set({
        isLoading: false,
        error:
          error instanceof Error ? error.message : 'Failed to add server. Check URL and token.',
      });
      throw error;
    }
  },

  /**
   * Remove a server connection
   */
  removeServer: async (serverId: string) => {
    try {
      set({ isLoading: true });

      await storage.removeServer(serverId);

      // Reload state
      const servers = await storage.getServers();
      const activeServerId = await storage.getActiveServerId();
      const activeServer = activeServerId
        ? (servers.find((s) => s.id === activeServerId) ?? null)
        : null;

      // Reset API client
      resetApiClient();

      if (servers.length === 0) {
        set({
          servers: [],
          activeServerId: null,
          activeServer: null,
          isAuthenticated: false,
          serverUrl: null,
          serverName: null,
          isLoading: false,
          error: null,
        });
      } else {
        set({
          servers,
          activeServerId,
          activeServer,
          isAuthenticated: true,
          serverUrl: activeServer?.url ?? null,
          serverName: activeServer?.name ?? null,
          isLoading: false,
        });
      }
    } catch (error) {
      console.error('Removing server failed:', error);
      set({
        isLoading: false,
        error: 'Failed to remove server',
      });
    }
  },

  /**
   * Switch to a different server
   */
  selectServer: async (serverId: string) => {
    try {
      const { servers } = get();
      const server = servers.find((s) => s.id === serverId);

      if (!server) {
        throw new Error('Server not found');
      }

      // Set as active
      await storage.setActiveServerId(serverId);

      // Reset API client to use new server
      resetApiClient();

      set({
        activeServerId: serverId,
        activeServer: server,
        serverUrl: server.url,
        serverName: server.name,
      });
    } catch (error) {
      console.error('Selecting server failed:', error);
      set({
        error: 'Failed to switch server',
      });
    }
  },

  /**
   * Remove the currently active server
   * @deprecated Use removeServer(serverId) instead for clarity
   */
  logout: async () => {
    const { activeServerId } = get();
    if (activeServerId) {
      await get().removeServer(activeServerId);
    }
  },

  /**
   * Remove the currently active server (alias for logout with clearer name)
   */
  removeActiveServer: async () => {
    const { activeServerId } = get();
    if (activeServerId) {
      await get().removeServer(activeServerId);
    }
  },

  /**
   * Clear error message
   */
  clearError: () => {
    set({ error: null });
  },
}));
