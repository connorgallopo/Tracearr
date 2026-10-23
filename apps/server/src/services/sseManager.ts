/**
 * SSE Connection Manager
 *
 * Manages Server-Sent Events connections for all media servers.
 * Coordinates between SSE (real-time) and poller (fallback/reconciliation).
 *
 * Architecture:
 * - Primary: SSE connections for instant session updates
 * - Fallback: Polling when SSE fails or plugin is absent
 * - Reconciliation: Light periodic poll to catch any missed events
 *
 * Failure stance: always degrade safely to polling. If Redis writes fail,
 * detection errors, or anything is uncertain, the server runs on polling.
 * Ingestion never stops.
 */

import { EventEmitter } from 'events';
import {
  POLLING_INTERVALS,
  WS_EVENTS,
  type SSEConnectionState,
  type SSEConnectionStatus,
  type ServerConnectionStatus,
  type PluginIssue,
  type PlexPlaySessionNotification,
} from '@tracearr/shared';
import { registerService, unregisterService } from './serviceTracker.js';
import { liveServers } from './liveServers.js';
import {
  PlexEventSource,
  type PlexEventSourceEvents,
  type StaticTranscode,
} from './mediaServer/plex/eventSource.js';
import {
  JellyfinEmbyEventSource,
  type PluginSessionEvent,
  type PluginLibraryEvent,
  type PluginServerStats,
  type PluginTranscodePullEvent,
} from './mediaServer/shared/jellyfinEmbyEventSource.js';
import { recordServerStatsSample } from './serverLiveStats.js';
import { pollServerDownloads } from './downloads/activityLogPoll.js';
import { deliveredFromTranscode } from './downloads/enrich.js';
import { isTrack, recordDownload } from './downloads/recorder.js';
import { recordTranscodePullEvent } from './downloads/transcodePull.js';
import { getServerUserIdByExternalId } from '../jobs/poller/database.js';
import { getRedis } from '../lib/redisShared.js';
import { probeSsePlugin } from './mediaServer/shared/ssePluginProbe.js';
import { broadcastToSessions } from '../websocket/index.js';
import { isLeader } from './leaderLease.js';
import { triggerServerPoll } from '../jobs/poller/index.js';
import { compareVersions } from '../utils/pluginVersion.js';
import {
  clearPendingLibraryEventSync,
  recordLibraryEvent,
  clearPendingLibraryEventSyncs,
} from './libraryEventSync.js';
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
  // Kept for the plugin-list probe when the SSE endpoint 404s
  url: string;
  token: string;
  eventSource: PlexEventSource | JellyfinEmbyEventSource | null;
  state: SSEConnectionState;
  inFallback: boolean;
  connectedAt: Date | null;
  lastEventAt: Date | null;
  pluginIssue: PluginIssue | null;
}

// Per-server debounce timers to coalesce rapid plugin events before polling
const pendingServerPolls = new Map<string, NodeJS.Timeout>();
// First-event timestamps backing the debounce max-wait: a trailing debounce
// alone never fires while events arrive faster than the delay, which is
// exactly the busy-server case, so the poll must fire unconditionally once
// the max wait elapses.
const pendingServerPollSince = new Map<string, number>();

const NUDGE_MIN_INTERVAL_MS = 60 * 1000;
const SERVER_POLL_DEBOUNCE_MS = 1000;
const SERVER_POLL_MAX_WAIT_MS = 2000;
// Min gap between plugin-list probes per server while its endpoint 404s
const PLUGIN_PROBE_MIN_INTERVAL_MS = 5 * 60 * 1000;

function scheduleServerPoll(serverId: string, serverName: string): void {
  if (!isLeader()) return;
  const now = Date.now();
  const firstEventAt = pendingServerPollSince.get(serverId);
  if (firstEventAt !== undefined && now - firstEventAt >= SERVER_POLL_MAX_WAIT_MS) {
    const existing = pendingServerPolls.get(serverId);
    if (existing) clearTimeout(existing);
    pendingServerPolls.delete(serverId);
    pendingServerPollSince.delete(serverId);
    console.log(`[PluginSSE] ${serverName}: live event burst, refreshing`);
    void triggerServerPoll(serverId);
    return;
  }
  if (firstEventAt === undefined) {
    pendingServerPollSince.set(serverId, now);
  }

  const existing = pendingServerPolls.get(serverId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    pendingServerPolls.delete(serverId);
    pendingServerPollSince.delete(serverId);
    console.log(`[PluginSSE] ${serverName}: live event, refreshing`);
    void triggerServerPoll(serverId);
  }, SERVER_POLL_DEBOUNCE_MS);

  pendingServerPolls.set(serverId, timer);
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
  private pendingOperations = new Set<string>();
  private latestPluginVersion: string | null = null;
  private lastNudgeAt = new Map<string, number>();
  private lastPluginProbeAt = new Map<string, number>();
  private pluginProbesInFlight = new Set<string>();

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
   * Start SSE connections for all servers
   */
  async start(): Promise<void> {
    if (!this.initialized) {
      throw new Error('SSEManager not initialized');
    }

    const allServers = await liveServers();

    console.log(`[SSEManager] Starting SSE for ${allServers.length} server(s)`);

    await Promise.all(
      allServers.map((server) =>
        this.addServer(server.id, server.name, server.type, server.url, server.token)
      )
    );

    this.startReconciliation();
    registerService('sse-manager', {
      name: 'SSE Manager',
      description: 'Manages real-time SSE connections',
      intervalMs: POLLING_INTERVALS.SSE_RECONCILIATION,
    });
  }

  /**
   * Stop all SSE connections
   */
  async stop(): Promise<void> {
    console.log('[SSEManager] Stopping all connections');

    if (this.reconciliationTimer) {
      clearInterval(this.reconciliationTimer);
      this.reconciliationTimer = null;
    }
    unregisterService('sse-manager');

    for (const timer of pendingServerPolls.values()) {
      clearTimeout(timer);
    }
    pendingServerPolls.clear();
    pendingServerPollSince.clear();
    clearPendingLibraryEventSyncs();

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
    if (this.pendingOperations.has(serverId)) {
      console.log(`[SSEManager] Operation already in progress for ${serverName}, skipping`);
      return;
    }
    this.pendingOperations.add(serverId);

    try {
      if (this.connections.has(serverId)) {
        await this.removeServerInternal(serverId);
      }

      const connection: ServerConnection = {
        serverId,
        serverName,
        serverType,
        url,
        token,
        eventSource: null,
        state: 'disconnected',
        // Start in fallback so the poller covers the server until a stream actually opens
        inFallback: true,
        connectedAt: null,
        lastEventAt: null,
        pluginIssue: null,
      };

      try {
        if (serverType === 'plex') {
          const eventSource = new PlexEventSource({
            serverId,
            serverName,
            url,
            token,
          });

          this.setupPlexEventHandlers(eventSource, serverId, serverName);
          connection.eventSource = eventSource;
          await eventSource.connect();
        } else {
          // Jellyfin/Emby: attempt plugin SSE connection
          const eventSource = new JellyfinEmbyEventSource({
            serverId,
            serverName,
            url,
            serverType,
            token,
          });

          this.setupJellyfinEmbyEventHandlers(eventSource, serverId, serverName, serverType);
          connection.eventSource = eventSource;
          await eventSource.connect();
        }
      } catch (error) {
        // connect() threw before the connection was tracked in this.connections,
        // so removeServerInternal's cleanup path never sees it. Tear down the
        // listeners and any partial connection here instead of leaking them.
        if (connection.eventSource) {
          connection.eventSource.removeAllListeners();
          connection.eventSource.disconnect();
        }
        throw error;
      }

      this.connections.set(serverId, connection);
    } finally {
      this.pendingOperations.delete(serverId);
    }
  }

  /**
   * Remove a server and disconnect SSE
   */
  async removeServer(serverId: string): Promise<void> {
    if (this.pendingOperations.has(serverId)) {
      console.log(
        `[SSEManager] Operation already in progress for server ${serverId}, skipping remove`
      );
      return;
    }
    this.pendingOperations.add(serverId);

    try {
      await this.removeServerInternal(serverId);
    } finally {
      this.pendingOperations.delete(serverId);
    }
  }

  private async removeServerInternal(serverId: string): Promise<void> {
    const connection = this.connections.get(serverId);
    if (!connection) {
      return;
    }

    const pending = pendingServerPolls.get(serverId);
    if (pending) {
      clearTimeout(pending);
      pendingServerPolls.delete(serverId);
    }
    pendingServerPollSince.delete(serverId);
    clearPendingLibraryEventSync(serverId);

    if (connection.eventSource) {
      connection.eventSource.removeAllListeners();
      connection.eventSource.disconnect();
    }

    this.connections.delete(serverId);
    this.lastNudgeAt.delete(serverId);
    this.lastPluginProbeAt.delete(serverId);
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
   * Set the latest known plugin version (called by the update checker)
   */
  setLatestPluginVersion(v: string | null): void {
    this.latestPluginVersion = v;
  }

  /**
   * Get the latest known plugin version
   */
  getLatestPluginVersion(): string | null {
    return this.latestPluginVersion;
  }

  /**
   * Get the reported plugin version for a connected server, if any
   */
  getPluginVersion(serverId: string): string | null {
    const connection = this.connections.get(serverId);
    if (!connection?.eventSource) return null;
    const status = connection.eventSource.getStatus() as { pluginVersion?: string | null };
    return status.pluginVersion ?? null;
  }

  /**
   * Retry a fallback server's SSE now instead of waiting for the re-probe timer
   */
  nudgeReconnect(serverId: string): void {
    const connection = this.connections.get(serverId);
    if (!connection?.eventSource) return;
    // 'unsupported' is nudgeable too: a reachable server (the poll just
    // succeeded) may have had its 404 verdict caused by a proxy hiccup, a
    // restart, or the plugin being installed since.
    if (connection.state !== 'fallback' && connection.state !== 'unsupported') return;

    const now = Date.now();
    const last = this.lastNudgeAt.get(serverId) ?? 0;
    if (now - last < NUDGE_MIN_INTERVAL_MS) return;
    this.lastNudgeAt.set(serverId, now);

    connection.eventSource.retryFromFallback();
  }

  /**
   * Get list of servers that need polling (fallback mode or non-SSE-connected)
   * JF/Emby servers with active plugin SSE are NOT included; events drive them.
   * JF/Emby servers in unsupported/fallback state ARE included for normal polling.
   */
  getServersNeedingPoll(): string[] {
    const serverIds: string[] = [];

    for (const connection of this.connections.values()) {
      if (connection.inFallback) {
        serverIds.push(connection.serverId);
      }
    }

    return serverIds;
  }

  /**
   * Set up event handlers for a PlexEventSource
   */
  private setupPlexEventHandlers(
    eventSource: PlexEventSource,
    serverId: string,
    serverName: string
  ): void {
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

    eventSource.on('library:added', ({ ratingKey }: { ratingKey: string }) => {
      recordLibraryEvent({ serverId, serverName, type: 'added', itemId: ratingKey });
    });

    eventSource.on('library:removed', ({ ratingKey }: { ratingKey: string }) => {
      recordLibraryEvent({ serverId, serverName, type: 'removed', itemId: ratingKey });
    });

    // An app download is converted first; the transfer's activity starts seconds after this
    let lastStaticTranscode: StaticTranscode | null = null;
    eventSource.on('transcode:static:ended', (transcode: StaticTranscode) => {
      lastStaticTranscode = transcode;
    });

    // One at a time, so a burst of ranged requests collapses into the row the first one opens
    let downloads = Promise.resolve();
    eventSource.on(
      'download:ended',
      ({
        userId,
        ratingKey,
        title,
        partId,
        deviceId,
        startedAt,
      }: PlexEventSourceEvents['download:ended']) => {
        // A web or raw download carries no deviceID and is never converted
        const delivered = deviceId ? deliveredFromTranscode(lastStaticTranscode, startedAt) : null;
        if (delivered) lastStaticTranscode = null;
        downloads = downloads
          .then(async () => {
            if (await isTrack(serverId, ratingKey)) return;
            await recordDownload({
              serverId,
              serverUserId: await getServerUserIdByExternalId(serverId, userId),
              ratingKey,
              title,
              app: null,
              device: null,
              source: 'plex',
              seenAt: new Date(),
              partId,
              deviceId,
              delivered,
            });
          })
          .catch((error: unknown) => {
            console.error(`[SSEManager] Failed to record a download on ${serverName}:`, error);
          });
      }
    );

    eventSource.on('connection:state', (state: SSEConnectionState) => {
      this.handleConnectionStateChange(serverId, serverName, state, eventSource.getStatus());
    });

    eventSource.on('connection:error', (error: Error) => {
      console.error(`[SSEManager] Connection error for ${serverName}:`, error.message);
    });
  }

  /**
   * Build a ServerConnectionStatus from a live connection + SSEConnectionStatus snapshot.
   * mode='realtime' only when state==='connected'; everything else is 'polling'.
   */
  private buildConnectionStatus(
    serverId: string,
    serverName: string,
    serverType: 'plex' | 'jellyfin' | 'emby',
    status: SSEConnectionStatus
  ): ServerConnectionStatus {
    const state = status.state;
    const pluginVersion = (status as { pluginVersion?: string | null }).pluginVersion ?? null;
    const latest = this.latestPluginVersion;
    // Null version on a connection that has been up >30s means a pre-hello plugin build
    const connectedLongEnough =
      state === 'connected' &&
      status.connectedAt !== null &&
      Date.now() - status.connectedAt.getTime() > 30_000;
    const pluginUpdateAvailable =
      serverType !== 'plex' &&
      latest !== null &&
      state === 'connected' &&
      (pluginVersion === null ? connectedLongEnough : compareVersions(pluginVersion, latest) < 0);
    return {
      serverId,
      serverName,
      serverType,
      mode: state === 'connected' ? 'realtime' : 'polling',
      state,
      lastEventAt: status.lastEventAt?.toISOString() ?? null,
      since: state === 'connected' ? (status.connectedAt?.toISOString() ?? null) : null,
      error: status.error,
      pluginVersion,
      pluginUpdateAvailable,
      pluginIssue:
        state === 'unsupported' ? (this.connections.get(serverId)?.pluginIssue ?? null) : null,
    };
  }

  /**
   * Re-write the current connection status for every active connection to Redis.
   * Called on the reconciliation interval (every 30s, well under the 600s TTL) so
   * the cache key never expires while the process is alive.
   *
   * Failure stance: if Redis is down a write fails silently, the key expires within
   * 600s, and the read route safely falls back to 'polling'. Real-time ingestion is
   * unaffected. This method never throws or broadcasts over WebSocket.
   */
  private refreshConnectionStatuses(): void {
    if (!this.cacheService) return;

    for (const connection of this.connections.values()) {
      if (!connection.eventSource) continue;

      const status = connection.eventSource.getStatus();
      const connectionStatus = this.buildConnectionStatus(
        connection.serverId,
        connection.serverName,
        connection.serverType,
        status
      );

      this.cacheService
        .setServerConnectionStatus(connection.serverId, connectionStatus)
        .catch((err: unknown) => {
          console.error(
            `[SSEManager] Failed to refresh connection status for ${connection.serverName}:`,
            err
          );
        });
    }
  }

  /**
   * Set up event handlers for a JellyfinEmbyEventSource
   */
  private setupJellyfinEmbyEventHandlers(
    eventSource: JellyfinEmbyEventSource,
    serverId: string,
    serverName: string,
    serverType: 'jellyfin' | 'emby'
  ): void {
    eventSource.on('session:event', (_event: PluginSessionEvent) => {
      const connection = this.connections.get(serverId);
      if (connection) connection.lastEventAt = new Date();
      // Trigger-poll approach: event arrived -> run existing poller pipeline for this server
      scheduleServerPoll(serverId, serverName);
    });

    // The plugin emits these today - see jellyfinEmbyEventSource.ts
    eventSource.on('library:event', ({ type, itemId }: PluginLibraryEvent) => {
      recordLibraryEvent({ serverId, serverName, type, itemId });
    });

    eventSource.on('download:event', () => {
      void pollServerDownloads(serverId).catch((error: unknown) => {
        console.error(`[SSEManager] Download poll failed for ${serverName}:`, error);
      });
    });

    eventSource.on('download:transcoded', (event: PluginTranscodePullEvent) => {
      void recordTranscodePullEvent(serverId, event).catch((error: unknown) => {
        console.error(
          `[SSEManager] Failed to record a converted download on ${serverName}:`,
          error
        );
      });
    });

    // Plugin v0.4+ CPU/RAM samples feed the live-stats endpoint's rolling buffer
    eventSource.on('stats:event', (sample: PluginServerStats) => {
      const connection = this.connections.get(serverId);
      if (connection) connection.lastEventAt = new Date();
      void recordServerStatsSample(getRedis(), serverId, sample);
    });

    eventSource.on('connection:state', (state: SSEConnectionState) => {
      const status = eventSource.getStatus();
      this.handleConnectionStateChange(serverId, serverName, state, status);

      const connection = this.connections.get(serverId);
      if (connection) {
        if (state === 'connected') {
          connection.pluginIssue = null;
        } else if (state === 'unsupported') {
          this.diagnoseUnsupported(serverId);
        }
      }

      this.publishJellyfinEmbyStatus(serverId, serverName, serverType, status);
    });

    eventSource.on('connection:error', (error: Error) => {
      console.error(`[SSEManager] Plugin SSE error for ${serverName}:`, error.message);
    });
  }

  private publishJellyfinEmbyStatus(
    serverId: string,
    serverName: string,
    serverType: 'jellyfin' | 'emby',
    status: SSEConnectionStatus
  ): void {
    const connectionStatus = this.buildConnectionStatus(serverId, serverName, serverType, status);

    // Persist to Redis and broadcast; fail-safe: errors here don't stop ingestion
    if (this.cacheService) {
      this.cacheService
        .setServerConnectionStatus(serverId, connectionStatus)
        .catch((err: unknown) => {
          console.error(`[SSEManager] Failed to write connection status for ${serverName}:`, err);
        });
    }

    broadcastToSessions(WS_EVENTS.SERVER_CONNECTION as 'server:connection', connectionStatus);
  }

  /**
   * Ask the server's plugin list why its SSE endpoint 404s, then republish the
   * connection status carrying the diagnosis. Throttled per server; the answer
   * distinguishes "not installed" from "installed but blocked by a proxy".
   */
  private diagnoseUnsupported(serverId: string): void {
    const connection = this.connections.get(serverId);
    if (!connection || connection.serverType === 'plex') return;
    if (this.pluginProbesInFlight.has(serverId)) return;

    const now = Date.now();
    const last = this.lastPluginProbeAt.get(serverId) ?? 0;
    if (now - last < PLUGIN_PROBE_MIN_INTERVAL_MS) return;
    this.lastPluginProbeAt.set(serverId, now);
    this.pluginProbesInFlight.add(serverId);

    const { url, token, serverType } = connection;
    void probeSsePlugin({ baseUrl: url, serverType, token })
      .then((issue) => {
        const current = this.connections.get(serverId);
        if (!current?.eventSource || current.state !== 'unsupported') return;
        current.pluginIssue = issue;
        console.log(`[SSEManager] Plugin diagnosis for ${current.serverName}: ${issue}`);
        this.publishJellyfinEmbyStatus(
          serverId,
          current.serverName,
          serverType,
          current.eventSource.getStatus()
        );
      })
      .finally(() => {
        this.pluginProbesInFlight.delete(serverId);
      });
  }

  /**
   * Shared state-change handler for all server types
   */
  private handleConnectionStateChange(
    serverId: string,
    serverName: string,
    state: SSEConnectionState,
    status: SSEConnectionStatus
  ): void {
    const connection = this.connections.get(serverId);
    if (!connection) return;

    connection.state = state;

    const isActive = state === 'connected';
    if (isActive) {
      connection.connectedAt = status.connectedAt;
    }

    const wasInFallback = connection.inFallback;
    // unsupported/fallback/disconnected/reconnecting all mean polling covers this server
    const needsFallback = state !== 'connected';

    if (needsFallback && !wasInFallback) {
      connection.inFallback = true;
      console.log(`[SSEManager] Server ${serverName} entering fallback mode (state: ${state})`);
      this.emit('fallback:activated', { serverId, serverName });
    } else if (!needsFallback && wasInFallback) {
      connection.inFallback = false;
      console.log(`[SSEManager] Server ${serverName} exiting fallback mode`);
      this.emit('fallback:deactivated', { serverId, serverName });
    }

    // For Plex, also emit the legacy SSEConnectionStatus event
    if (connection.serverType === 'plex') {
      this.emit('connection:status', status);
    }

    // Write Plex connection status to Redis too
    if (connection.serverType === 'plex' && this.cacheService) {
      const connStatus = this.buildConnectionStatus(serverId, serverName, 'plex', status);

      this.cacheService.setServerConnectionStatus(serverId, connStatus).catch((err: unknown) => {
        console.error(`[SSEManager] Failed to write connection status for ${serverName}:`, err);
      });

      broadcastToSessions(WS_EVENTS.SERVER_CONNECTION as 'server:connection', connStatus);
    }
  }

  /**
   * Start periodic reconciliation
   */
  private startReconciliation(): void {
    if (this.reconciliationTimer) {
      return;
    }

    console.log(
      `[SSEManager] Starting reconciliation (every ${POLLING_INTERVALS.SSE_RECONCILIATION / 1000}s)`
    );

    this.reconciliationTimer = setInterval(() => {
      // Server CRUD served by another instance never calls this instance's
      // refresh; converge on the DB server list here instead.
      void this.refresh().catch((error: unknown) => {
        console.error('[SSEManager] Reconciliation refresh failed:', error);
      });
      this.refreshConnectionStatuses();
      this.emit('reconciliation:needed');
    }, POLLING_INTERVALS.SSE_RECONCILIATION);
  }

  /**
   * Manually trigger a reconnection attempt for a server
   */
  async reconnect(serverId: string): Promise<void> {
    if (this.pendingOperations.has(serverId)) {
      console.log(
        `[SSEManager] Operation already in progress for server ${serverId}, skipping reconnect`
      );
      return;
    }
    this.pendingOperations.add(serverId);

    try {
      const connection = this.connections.get(serverId);
      if (!connection?.eventSource) {
        return;
      }

      console.log(`[SSEManager] Manual reconnect for ${connection.serverName}`);
      connection.eventSource.disconnect();
      await connection.eventSource.connect();
    } finally {
      this.pendingOperations.delete(serverId);
    }
  }

  /**
   * Refresh server list (call when servers are added/removed)
   */
  async refresh(): Promise<void> {
    // Only the leaseholder runs SSE connections. A follower serving a server
    // CRUD request must not build its own connection set; the leader
    // converges on the change via the reconciliation tick below.
    if (!isLeader()) {
      console.log('[SSEManager] Not the leader, skipping SSE refresh');
      return;
    }
    const refreshLockId = '__refresh__';
    if (this.pendingOperations.has(refreshLockId)) {
      console.log('[SSEManager] Refresh already in progress, skipping');
      return;
    }
    this.pendingOperations.add(refreshLockId);

    try {
      let allServers;
      try {
        allServers = await liveServers();
      } catch (error) {
        console.error('[SSEManager] Failed to fetch servers from database:', error);
        return;
      }

      const currentServerIds = new Set(allServers.map((s) => s.id));
      const connectedServerIds = new Set(this.connections.keys());

      for (const serverId of connectedServerIds) {
        if (!currentServerIds.has(serverId)) {
          await this.removeServerInternal(serverId);
        }
      }

      for (const server of allServers) {
        // A connection keeps the url and token it was built with, so matching
        // on id alone strands a rotated token here forever. Also the only
        // convergence path when a follower served the write.
        const connection = this.connections.get(server.id);
        if (connection?.token !== server.token || connection.url !== server.url) {
          await this.addServer(server.id, server.name, server.type, server.url, server.token);
        }
      }
    } finally {
      this.pendingOperations.delete(refreshLockId);
    }
  }
}

// Singleton instance
export const sseManager = new SSEManager();
