import { EventEmitter } from 'events';
import { SSE_CONFIG, type SSEConnectionState, type JellyfinEmbyServerType } from '@tracearr/shared';
import type { EventSourceFetchInit } from 'eventsource';
import { parseHelloPayload } from '../../../utils/pluginVersion.js';
import { mediaBrowserTokenHeader } from './baseMediaServerClient.js';

// Plugin SSE endpoint paths per server type
export const PLUGIN_SSE_PATH: Record<JellyfinEmbyServerType, string> = {
  jellyfin: '/api/sse/events',
  emby: '/emby/sse/events',
};

// The plugin sends a ping every 30s; allow two missed pings before assuming the
// stream died so a single dropped keep-alive doesn't force a needless reconnect
const PLUGIN_HEARTBEAT_TIMEOUT_MS = 90_000;

// When the plugin is absent (404), re-probe every 3 minutes so a newly-installed
// plugin gets picked up without a full server restart
const UNSUPPORTED_REPROBE_MS = 3 * 60 * 1000;

// Re-probe cadence once the reconnect budget is spent; polling covers data meanwhile
const FALLBACK_RETRY_MS = 3 * 60 * 1000;

// A 404 can come from a reverse proxy whose backend is restarting (Traefik 404s
// while a container is down), not just from a missing plugin. Require this many
// consecutive 404s before concluding the plugin is absent; anything less rides
// the normal reconnect backoff.
const UNSUPPORTED_404_THRESHOLD = 3;

interface EventSourceMessage {
  data: string;
  lastEventId?: string;
  origin?: string;
}

type EventSourceReadyState = 0 | 1 | 2;

interface EventSourceInit {
  withCredentials?: boolean;
  fetch?: (input: string | URL, init: EventSourceFetchInit) => Promise<Response>;
}

interface EventSource {
  readonly readyState: EventSourceReadyState;
  readonly url: string;
  onopen: ((this: EventSource, ev: Event) => void) | null;
  onmessage: ((this: EventSource, ev: EventSourceMessage) => void) | null;
  onerror: ((this: EventSource, ev: Event) => void) | null;
  close(): void;
  addEventListener(type: string, listener: (ev: EventSourceMessage) => void): void;
  removeEventListener(type: string, listener: (ev: EventSourceMessage) => void): void;
}

let EventSourceClass: new (url: string, init?: EventSourceInit) => EventSource;

export interface PluginSessionEvent {
  sessionId: string;
  itemId: string | null;
  userId: string | null;
  state: string;
  positionTicks: number | null;
}

// The Media-Server-SSE plugin emits these today: one event per changed item,
// JSON body `{ "itemId": "...", "itemType": "...", "parentId": "..." }`. The
// scheduled sync still runs as a backstop for anything missed here.
const LIBRARY_ADDED_EVENT = 'library.item.added';
const LIBRARY_REMOVED_EVENT = 'library.item.removed';

// Plugin v0.6+: one event per activity log download entry. The payload is informational;
// the activity log stays the source of truth, so this only makes the download poll immediate.
const DOWNLOAD_EVENT = 'library.item.downloaded';

// Plugin Jellyfin builds: a device pulled a transcode without playing it for 20 s. Null fields
// are omitted from the JSON.
const TRANSCODE_PULL_EVENT = 'download.transcoded';

export interface PluginTranscodePullEvent {
  phase: 'started' | 'ended';
  userId: string;
  deviceId: string;
  itemId: string | null;
  bitrate: number | null;
  width: number | null;
  height: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
  bytesTranscoded: number | null;
  completionPercentage: number | null;
}

function parseTranscodePullEvent(data: string): PluginTranscodePullEvent | null {
  const raw = JSON.parse(data) as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === 'string' ? raw[key] : null);
  const number = (key: string) => (typeof raw[key] === 'number' ? raw[key] : null);
  const phase = raw.phase;
  const userId = text('userId');
  const deviceId = text('deviceId');
  if ((phase !== 'started' && phase !== 'ended') || !userId || !deviceId) return null;
  return {
    phase,
    userId,
    deviceId,
    itemId: text('itemId'),
    bitrate: number('bitrate'),
    width: number('width'),
    height: number('height'),
    videoCodec: text('videoCodec'),
    audioCodec: text('audioCodec'),
    container: text('container'),
    bytesTranscoded: number('bytesTranscoded'),
    completionPercentage: number('completionPercentage'),
  };
}

export interface PluginLibraryEvent {
  type: 'added' | 'removed';
  itemId: string | null;
}

// Plugin v0.4+: CPU/RAM sample every 6s; host values omitted on non-Linux hosts
const SERVER_STATS_EVENT = 'server.stats';

export interface PluginServerStats {
  at: number;
  hostCpuUtilization: number | null;
  processCpuUtilization: number | null;
  hostMemoryUtilization: number | null;
  processMemoryUtilization: number | null;
}

export interface JellyfinEmbyEventSourceEvents {
  'session:event': PluginSessionEvent;
  'library:event': PluginLibraryEvent;
  'stats:event': PluginServerStats;
  'download:event': Record<string, never>;
  'download:transcoded': PluginTranscodePullEvent;
  'connection:state': SSEConnectionState;
  'connection:error': Error;
}

export class JellyfinEmbyEventSource extends EventEmitter {
  private readonly serverId: string;
  private readonly serverName: string;
  private readonly baseUrl: string;
  private readonly serverType: JellyfinEmbyServerType;
  private readonly token: string;

  private eventSource: EventSource | null = null;
  private state: SSEConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private consecutive404s = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private connectedAt: Date | null = null;
  private lastEventTime: Date | null = null;
  private lastError: Error | null = null;
  private pluginVersion: string | null = null;

  private openListener: ((e: Event) => void) | null = null;
  private sessionEventListener: ((e: EventSourceMessage) => void) | null = null;
  private libraryAddedListener: ((e: EventSourceMessage) => void) | null = null;
  private libraryRemovedListener: ((e: EventSourceMessage) => void) | null = null;
  private pingListener: ((e: EventSourceMessage) => void) | null = null;
  private helloListener: ((ev: EventSourceMessage) => void) | null = null;
  private statsListener: ((e: EventSourceMessage) => void) | null = null;
  private downloadListener: ((e: EventSourceMessage) => void) | null = null;
  private transcodePullListener: ((e: EventSourceMessage) => void) | null = null;
  private errorListener: ((e: Event) => void) | null = null;

  constructor(config: {
    serverId: string;
    serverName: string;
    url: string;
    serverType: JellyfinEmbyServerType;
    token: string;
  }) {
    super();
    this.serverId = config.serverId;
    this.serverName = config.serverName;
    this.baseUrl = config.url.replace(/\/$/, '');
    this.serverType = config.serverType;
    this.token = config.token;
  }

  getState(): SSEConnectionState {
    return this.state;
  }

  getStatus(): {
    serverId: string;
    serverName: string;
    state: SSEConnectionState;
    connectedAt: Date | null;
    lastEventAt: Date | null;
    reconnectAttempts: number;
    error: string | null;
    pluginVersion: string | null;
  } {
    return {
      serverId: this.serverId,
      serverName: this.serverName,
      state: this.state,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventTime,
      reconnectAttempts: this.reconnectAttempts,
      error: this.lastError?.message ?? null,
      pluginVersion: this.pluginVersion,
    };
  }

  async connect(): Promise<void> {
    if (!EventSourceClass) {
      const module = await import('eventsource');
      EventSourceClass = module.EventSource as unknown as typeof EventSourceClass;
    }

    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.setState('connecting');
    this.clearTimers();

    const path = PLUGIN_SSE_PATH[this.serverType];
    const url = `${this.baseUrl}${path}`;
    const authHeaders = mediaBrowserTokenHeader(this.serverType, this.token);

    console.log(`[PluginSSE] Connecting to ${this.serverName} at ${url}`);

    try {
      // eventsource v4 silently ignores the `headers` init option; use `fetch` to forward auth
      this.eventSource = new EventSourceClass(url, {
        fetch: (input, init) => {
          const merged = new Headers(init.headers);
          for (const [k, v] of Object.entries(authHeaders)) merged.set(k, v);
          return fetch(input, { ...init, headers: merged });
        },
      });

      this.startConnectionTimeout();

      this.openListener = () => {
        if (this.state !== 'connecting') return;
        this.clearConnectionTimeout();
        console.log(`[PluginSSE] Connected to ${this.serverName}`);
        this.connectedAt = new Date();
        this.setState('connected');
        this.reconnectAttempts = 0;
        this.consecutive404s = 0;
        this.lastError = null;
        this.startHeartbeatMonitor();
      };

      const handleSessionEvent = (ev: EventSourceMessage) => {
        this.lastEventTime = new Date();
        this.resetHeartbeatMonitor();
        if (!ev.data) return;
        try {
          const raw = JSON.parse(ev.data) as Record<string, unknown>;
          const payload: PluginSessionEvent = {
            sessionId: (raw.sessionId as string | undefined) ?? '',
            itemId: (raw.itemId as string | undefined) ?? null,
            userId: (raw.userId as string | undefined) ?? null,
            state: (raw.state as string | undefined) ?? 'unknown',
            positionTicks: (raw.positionTicks as number | undefined) ?? null,
          };
          this.emit('session:event', payload);
        } catch {
          // malformed payload — ignore, the trigger-poll approach doesn't need it
        }
      };

      const handleLibraryEvent = (type: 'added' | 'removed') => (ev: EventSourceMessage) => {
        this.lastEventTime = new Date();
        this.resetHeartbeatMonitor();
        if (!ev.data) return;
        try {
          const raw = JSON.parse(ev.data) as Record<string, unknown>;
          const itemId = typeof raw.itemId === 'string' ? raw.itemId : null;
          this.emit('library:event', { type, itemId });
        } catch {
          // malformed payload - ignore, the debounced sync still covers the change
        }
      };

      const handleStatsEvent = (ev: EventSourceMessage) => {
        this.lastEventTime = new Date();
        this.resetHeartbeatMonitor();
        if (!ev.data) return;
        try {
          const raw = JSON.parse(ev.data) as Record<string, unknown>;
          if (typeof raw.at !== 'number') return;
          this.emit('stats:event', {
            at: raw.at,
            hostCpuUtilization:
              typeof raw.hostCpuUtilization === 'number' ? raw.hostCpuUtilization : null,
            processCpuUtilization:
              typeof raw.processCpuUtilization === 'number' ? raw.processCpuUtilization : null,
            hostMemoryUtilization:
              typeof raw.hostMemoryUtilization === 'number' ? raw.hostMemoryUtilization : null,
            processMemoryUtilization:
              typeof raw.processMemoryUtilization === 'number'
                ? raw.processMemoryUtilization
                : null,
          });
        } catch {
          // malformed payload - drop the sample, the next one is 6s away
        }
      };

      this.sessionEventListener = handleSessionEvent;
      this.libraryAddedListener = handleLibraryEvent('added');
      this.libraryRemovedListener = handleLibraryEvent('removed');
      this.statsListener = handleStatsEvent;
      this.downloadListener = () => {
        this.lastEventTime = new Date();
        this.resetHeartbeatMonitor();
        this.emit('download:event', {});
      };
      this.transcodePullListener = (ev: EventSourceMessage) => {
        this.lastEventTime = new Date();
        this.resetHeartbeatMonitor();
        if (!ev.data) return;
        try {
          const event = parseTranscodePullEvent(ev.data);
          if (event) this.emit('download:transcoded', event);
        } catch {
          // malformed payload - the sessions poll still sees the pull
        }
      };
      this.pingListener = () => {
        this.lastEventTime = new Date();
        this.resetHeartbeatMonitor();
      };
      this.helloListener = (ev: EventSourceMessage) => {
        this.lastEventTime = new Date();
        this.resetHeartbeatMonitor();
        const hello = ev.data ? parseHelloPayload(ev.data) : null;
        if (hello) {
          this.pluginVersion = hello.version;
          console.log(`[PluginSSE] ${this.serverName} plugin version ${hello.version}`);
        }
      };

      this.errorListener = (ev: Event) => {
        this.handleError(ev);
      };

      this.eventSource.onopen = this.openListener;
      this.eventSource.onerror = this.errorListener;
      // Reset the heartbeat on any unnamed data line too (not just named events),
      // so keep-alives sent without an event name still count as liveness.
      this.eventSource.onmessage = () => {
        this.lastEventTime = new Date();
        this.resetHeartbeatMonitor();
      };

      for (const eventName of [
        'playing',
        'progress',
        'paused',
        'stopped',
        'session.start',
        'session.end',
      ]) {
        this.eventSource.addEventListener(eventName, this.sessionEventListener);
      }
      this.eventSource.addEventListener(LIBRARY_ADDED_EVENT, this.libraryAddedListener);
      this.eventSource.addEventListener(LIBRARY_REMOVED_EVENT, this.libraryRemovedListener);
      this.eventSource.addEventListener(SERVER_STATS_EVENT, this.statsListener);
      this.eventSource.addEventListener(DOWNLOAD_EVENT, this.downloadListener);
      this.eventSource.addEventListener(TRANSCODE_PULL_EVENT, this.transcodePullListener);
      this.eventSource.addEventListener('ping', this.pingListener);
      this.eventSource.addEventListener('hello', this.helloListener);
    } catch (error) {
      this.handleError(error);
    }
  }

  disconnect(): void {
    console.log(`[PluginSSE] Disconnecting from ${this.serverName}`);
    this.clearTimers();
    this.cleanupEventSource();
    this.setState('disconnected');
    this.connectedAt = null;
  }

  retryFromFallback(): void {
    // 'unsupported' too: a wrong 404 verdict (proxy hiccup, plugin installed
    // later) should heal as soon as a poll proves the server reachable.
    if (this.state !== 'fallback' && this.state !== 'unsupported') return;
    console.log(`[PluginSSE] Poll reached ${this.serverName}, retrying SSE from ${this.state}`);
    this.clearTimers();
    this.reconnectAttempts = 0;
    void this.connect();
  }

  private cleanupEventSource(): void {
    if (!this.eventSource) return;

    this.eventSource.onopen = null;
    this.eventSource.onerror = null;
    this.eventSource.onmessage = null;

    if (this.sessionEventListener) {
      for (const eventName of [
        'playing',
        'progress',
        'paused',
        'stopped',
        'session.start',
        'session.end',
      ]) {
        this.eventSource.removeEventListener(eventName, this.sessionEventListener);
      }
    }
    if (this.libraryAddedListener) {
      this.eventSource.removeEventListener(LIBRARY_ADDED_EVENT, this.libraryAddedListener);
    }
    if (this.libraryRemovedListener) {
      this.eventSource.removeEventListener(LIBRARY_REMOVED_EVENT, this.libraryRemovedListener);
    }
    if (this.statsListener) {
      this.eventSource.removeEventListener(SERVER_STATS_EVENT, this.statsListener);
    }
    if (this.downloadListener) {
      this.eventSource.removeEventListener(DOWNLOAD_EVENT, this.downloadListener);
    }
    if (this.transcodePullListener) {
      this.eventSource.removeEventListener(TRANSCODE_PULL_EVENT, this.transcodePullListener);
    }
    if (this.pingListener) {
      this.eventSource.removeEventListener('ping', this.pingListener);
    }
    if (this.helloListener) {
      this.eventSource.removeEventListener('hello', this.helloListener);
    }

    this.eventSource.close();
    this.eventSource = null;
    this.openListener = null;
    this.sessionEventListener = null;
    this.libraryAddedListener = null;
    this.libraryRemovedListener = null;
    this.statsListener = null;
    this.downloadListener = null;
    this.transcodePullListener = null;
    this.pingListener = null;
    this.helloListener = null;
    this.errorListener = null;
    // pluginVersion survives cleanup as "last seen"; the next hello overwrites it
  }

  private handleError(error: unknown): void {
    this.clearTimers();
    this.cleanupEventSource();

    let errorMessage = 'Connection error';
    let statusCode: number | null = null;

    if (error instanceof Error) {
      errorMessage = error.message;
      // eventsource surfaces HTTP status in the message
      const match = /\b(4\d{2}|5\d{2})\b/.exec(errorMessage);
      if (match?.[1]) statusCode = parseInt(match[1], 10);
    } else if (typeof error === 'object' && error !== null) {
      const obj = error as Record<string, unknown>;
      if ('message' in obj) errorMessage = String(obj.message);
      // eventsource v4 ErrorEvent carries the HTTP status in `.code`, not `.status`
      if (typeof obj.code === 'number') {
        statusCode = obj.code;
      } else if ('status' in obj) {
        statusCode = Number(obj.status);
      } else {
        const match = /\b(4\d{2}|5\d{2})\b/.exec(errorMessage);
        if (match?.[1]) statusCode = parseInt(match[1], 10);
      }
    }

    this.lastError = error instanceof Error ? error : new Error(errorMessage);
    this.emit('connection:error', this.lastError);

    // 404 suggests the plugin is not installed, but a proxy can 404 while its
    // backend restarts, so only conclude unsupported after several in a row
    if (statusCode === 404) {
      this.consecutive404s++;
      if (this.consecutive404s < UNSUPPORTED_404_THRESHOLD) {
        console.log(
          `[PluginSSE] 404 from ${this.serverName} (${this.consecutive404s}/${UNSUPPORTED_404_THRESHOLD} before assuming plugin absent), retrying`
        );
        this.scheduleReconnect();
        return;
      }
      console.log(
        `[PluginSSE] Plugin endpoint 404 on ${this.serverName} (${this.consecutive404s} consecutive), will re-probe in ${UNSUPPORTED_REPROBE_MS / 1000}s`
      );
      this.setState('unsupported');
      this.reconnectTimer = setTimeout(() => {
        if (this.state !== 'disconnected') {
          console.log(`[PluginSSE] Re-probing ${this.serverName} for plugin`);
          void this.connect();
        }
      }, UNSUPPORTED_REPROBE_MS);
      return;
    }

    this.consecutive404s = 0;

    // 401/403 — auth issue, use standard reconnect but don't claim unsupported
    if (statusCode === 401 || statusCode === 403) {
      console.error(`[PluginSSE] Auth error on ${this.serverName}: ${errorMessage}`);
      this.scheduleReconnect();
      return;
    }

    // Stream drop or other error — reconnect with backoff
    console.error(`[PluginSSE] Error on ${this.serverName}: ${errorMessage}`);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= SSE_CONFIG.MAX_RETRIES) {
      console.error(
        `[PluginSSE] Max retries reached for ${this.serverName}, falling back to polling, retrying in ${FALLBACK_RETRY_MS / 1000}s`
      );
      this.setState('fallback');
      this.reconnectTimer = setTimeout(() => {
        if (this.state !== 'disconnected') {
          console.log(`[PluginSSE] Retrying SSE for ${this.serverName} from fallback`);
          this.reconnectAttempts = 0;
          void this.connect();
        }
      }, FALLBACK_RETRY_MS);
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    const baseDelay = Math.min(
      SSE_CONFIG.INITIAL_RETRY_DELAY_MS *
        Math.pow(SSE_CONFIG.RETRY_MULTIPLIER, this.reconnectAttempts - 1),
      SSE_CONFIG.MAX_RETRY_DELAY_MS
    );
    const delay = baseDelay + Math.random() * 1000;

    console.log(
      `[PluginSSE] Reconnecting to ${this.serverName} in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${SSE_CONFIG.MAX_RETRIES})`
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.state === 'disconnected') return;
      void this.connect();
    }, delay);
  }

  private startHeartbeatMonitor(): void {
    this.resetHeartbeatMonitor();
  }

  private resetHeartbeatMonitor(): void {
    if (this.heartbeatTimer) clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => {
      if (this.state === 'disconnected') return;
      console.warn(`[PluginSSE] Heartbeat timeout on ${this.serverName}, reconnecting`);
      this.handleError(new Error('Heartbeat timeout'));
    }, PLUGIN_HEARTBEAT_TIMEOUT_MS);
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearConnectionTimeout();
  }

  private startConnectionTimeout(): void {
    this.clearConnectionTimeout();
    this.connectionTimer = setTimeout(() => {
      if (this.state === 'disconnected') return;
      console.warn(`[PluginSSE] Connection timeout on ${this.serverName}`);
      this.handleError(new Error('Connection timeout'));
    }, PLUGIN_HEARTBEAT_TIMEOUT_MS);
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimer) {
      clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    }
  }

  private setState(state: SSEConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('connection:state', state);
    }
  }
}
