/**
 * SSE Connection Manager
 *
 * Manages Server-Sent Events connections for all Plex servers.
 * Coordinates between SSE (real-time) and poller (fallback/reconciliation).
 *
 * Architecture:
 * - Primary: SSE connections for instant session updates
 * - Fallback: Polling when SSE fails or for servers that don't support SSE
 * - Reconciliation: Light periodic poll to catch any missed events
 */

import { EventEmitter } from 'events';
import { eq } from 'drizzle-orm';
import {
  POLLING_INTERVALS,
  type SSEConnectionState,
  type SSEConnectionStatus,
  type PlexPlaySessionNotification,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { servers } from '../db/schema.js';
import { PlexEventSource } from './mediaServer/plex/eventSource.js';
import type { CacheService, PubSubService } from './cache.js';

// Events emitted by SSEManager for consumers
export interface SSEManagerEvents {
  'plex:session:playing': { serverId: string; notification: PlexPlaySessionNotification };
  'plex:session:paused': { serverId: string; notification: PlexPlaySessionNotification };
  'plex:session:stopped': { serverId: string; notification: PlexPlaySessionNotification };
  'plex:session:progress': { serverId: string; notification: PlexPlaySessionNotification };
  'connection:status': SSEConnectionStatus;
  'fallback:activated': { serverId: string; serverName: string };
  'fallback:deactivated': { serverId: string; serverName: string };
}

interface ServerConnection {
  serverId: string;
  serverName: string;
  serverType: 'plex' | 'jellyfin' | 'emby';
  eventSource: PlexEventSource | null;
  state: SSEConnectionState;
  inFallback: boolean;
}

/**
 * SSEManager - Centralized management of SSE connections
 *
 * @example
 * const manager = new SSEManager();
 * await manager.initialize(cacheService, pubSubService);
 *
 * manager.on('plex:session:playing', ({ serverId, notification }) => {
 *   // Handle new/resumed playback
 * });
 *
 * manager.on('fallback:activated', ({ serverId }) => {
 *   // Enable polling for this server
 * });
 */
export class SSEManager extends EventEmitter {
  private connections = new Map<string, ServerConnection>();
  private cacheService: CacheService | null = null;
  private pubSubService: PubSubService | null = null;
  private reconciliationTimer: NodeJS.Timeout | null = null;
  private initialized = false;

  /**
   * Initialize the SSE manager with cache services
   */
  async initialize(cache: CacheService, pubSub: PubSubService): Promise<void> {
    if (this.initialized) {
      return;
    }

    this.cacheService = cache;
    this.pubSubService = pubSub;
    this.initialized = true;

    console.log('[SSEManager] Initialized');
  }

  /**
   * Start SSE connections for all Plex servers
   */
  async start(): Promise<void> {
    if (!this.initialized) {
      throw new Error('SSEManager not initialized');
    }

    // Get all Plex servers
    const allServers = await db.select().from(servers).where(eq(servers.type, 'plex'));

    console.log(`[SSEManager] Starting SSE for ${allServers.length} Plex server(s)`);

    // Create SSE connections for each Plex server
    for (const server of allServers) {
      await this.addServer(server.id, server.name, server.type as 'plex', server.url, server.token);
    }

    // Start reconciliation timer
    this.startReconciliation();
  }

  /**
   * Stop all SSE connections
   */
  async stop(): Promise<void> {
    console.log('[SSEManager] Stopping all connections');

    // Stop reconciliation
    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }

    // Disconnect all SSE connections
    for (const connection of this.connections.values()) {
      if (connection.eventSource) {
        connection.eventSource.disconnect();
      }
    }

    this.connections.clear();
  }

  /**
   * Add a server and establish SSE connection
   */
  async addServer(
    serverId: string,
    serverName: string,
    serverType: 'plex' | 'jellyfin' | 'emby',
    url: string,
    token: string
  ): Promise<void> {
    // Remove existing connection if present
    if (this.connections.has(serverId)) {
      await this.removeServer(serverId);
    }

    const connection: ServerConnection = {
      serverId,
      serverName,
      serverType,
      eventSource: null,
      state: 'disconnected',
      inFallback: false,
    };

    // Only Plex supports SSE currently
    if (serverType === 'plex') {
      const eventSource = new PlexEventSource({
        serverId,
        serverName,
        url,
        token,
      });

      // Wire up event handlers
      this.setupEventHandlers(eventSource, serverId, serverName);

      connection.eventSource = eventSource;

      // Connect
      await eventSource.connect();
    } else {
      // Jellyfin/Emby: Start in fallback mode (polling)
      connection.inFallback = true;
      connection.state = 'fallback';
      this.emit('fallback:activated', { serverId, serverName });
    }

    this.connections.set(serverId, connection);
  }

  /**
   * Remove a server and disconnect SSE
   */
  async removeServer(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return;
    }

    if (connection.eventSource) {
      connection.eventSource.removeAllListeners();
      connection.eventSource.disconnect();
    }

    this.connections.delete(serverId);
    console.log(`[SSEManager] Removed server ${connection.serverName}`);
  }

  /**
   * Get status of all connections
   */
  getStatus(): SSEConnectionStatus[] {
    const statuses: SSEConnectionStatus[] = [];

    for (const connection of this.connections.values()) {
      if (connection.eventSource) {
        statuses.push(connection.eventSource.getStatus());
      } else {
        // Non-SSE server (Jellyfin/Emby)
        statuses.push({
          serverId: connection.serverId,
          serverName: connection.serverName,
          state: connection.state,
          connectedAt: null,
          lastEventAt: null,
          reconnectAttempts: 0,
          error: null,
        });
      }
    }

    return statuses;
  }

  /**
   * Check if a server is using fallback (polling)
   */
  isInFallback(serverId: string): boolean {
    const connection = this.connections.get(serverId);
    return connection?.inFallback ?? true; // Default to fallback if not found
  }

  /**
   * Get list of servers that need polling (fallback mode or non-Plex)
   */
  getServersNeedingPoll(): string[] {
    const serverIds: string[] = [];

    for (const connection of this.connections.values()) {
      if (connection.inFallback || connection.serverType !== 'plex') {
        serverIds.push(connection.serverId);
      }
    }

    return serverIds;
  }

  /**
   * Set up event handlers for a PlexEventSource
   */
  private setupEventHandlers(
    eventSource: PlexEventSource,
    serverId: string,
    serverName: string
  ): void {
    // Session events - forward to processor
    eventSource.on('session:playing', (notification: PlexPlaySessionNotification) => {
      this.emit('plex:session:playing', { serverId, notification });
    });

    eventSource.on('session:paused', (notification: PlexPlaySessionNotification) => {
      this.emit('plex:session:paused', { serverId, notification });
    });

    eventSource.on('session:stopped', (notification: PlexPlaySessionNotification) => {
      this.emit('plex:session:stopped', { serverId, notification });
    });

    eventSource.on('session:progress', (notification: PlexPlaySessionNotification) => {
      this.emit('plex:session:progress', { serverId, notification });
    });

    // Connection state changes
    eventSource.on('connection:state', (state: SSEConnectionState) => {
      const connection = this.connections.get(serverId);
      if (connection) {
        connection.state = state;

        // Handle fallback transitions
        if (state === 'fallback' && !connection.inFallback) {
          connection.inFallback = true;
          console.log(`[SSEManager] Server ${serverName} entering fallback mode`);
          this.emit('fallback:activated', { serverId, serverName });
        } else if (state === 'connected' && connection.inFallback) {
          connection.inFallback = false;
          console.log(`[SSEManager] Server ${serverName} exiting fallback mode`);
          this.emit('fallback:deactivated', { serverId, serverName });
        }

        // Emit status update
        this.emit('connection:status', eventSource.getStatus());
      }
    });

    eventSource.on('connection:error', (error: Error) => {
      console.error(`[SSEManager] Connection error for ${serverName}:`, error.message);
    });
  }

  /**
   * Start periodic reconciliation
   * Light poll to catch any events that might have been missed
   */
  private startReconciliation(): void {
    if (this.reconciliationTimer) {
      return;
    }

    console.log(
      `[SSEManager] Starting reconciliation (every ${POLLING_INTERVALS.SSE_RECONCILIATION / 1000}s)`
    );

    this.reconciliationTimer = setInterval(() => {
      this.emit('reconciliation:needed');
    }, POLLING_INTERVALS.SSE_RECONCILIATION);
  }

  /**
   * Manually trigger a reconnection attempt for a server
   */
  async reconnect(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection?.eventSource) {
      return;
    }

    console.log(`[SSEManager] Manual reconnect for ${connection.serverName}`);
    connection.eventSource.disconnect();
    await connection.eventSource.connect();
  }

  /**
   * Refresh server list (call when servers are added/removed)
   */
  async refresh(): Promise<void> {
    const allServers = await db.select().from(servers);

    const currentServerIds = new Set(allServers.map((s) => s.id));
    const connectedServerIds = new Set(this.connections.keys());

    // Remove servers that no longer exist
    for (const serverId of connectedServerIds) {
      if (!currentServerIds.has(serverId)) {
        await this.removeServer(serverId);
      }
    }

    // Add new Plex servers
    for (const server of allServers) {
      if (!connectedServerIds.has(server.id) && server.type === 'plex') {
        await this.addServer(
          server.id,
          server.name,
          server.type as 'plex',
          server.url,
          server.token
        );
      }
    }
  }
}

// Singleton instance
export const sseManager = new SSEManager();
