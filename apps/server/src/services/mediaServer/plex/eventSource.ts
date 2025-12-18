/**
 * Plex EventSource Service
 *
 * Handles Server-Sent Events (SSE) connections to Plex servers for real-time
 * session notifications. This replaces aggressive polling with instant updates.
 *
 * Plex exposes SSE at: /:/eventsource/notifications
 *
 * Event types we care about:
 * - playing: Session started or resumed
 * - paused: Session paused
 * - stopped: Session ended
 * - progress: Playback position updated
 */

import { EventEmitter } from 'events';
import {
  SSE_CONFIG,
  type PlexSSENotification,
  type PlexPlaySessionNotification,
  type SSEConnectionState,
} from '@tracearr/shared';
import { plexHeaders } from '../../../utils/http.js';

// EventSource types for Node.js (using eventsource package)
interface EventSourceMessage {
  data: string;
  lastEventId?: string;
  origin?: string;
}

type EventSourceReadyState = 0 | 1 | 2;

interface EventSourceInit {
  headers?: Record<string, string>;
  withCredentials?: boolean;
}

// Dynamic import of eventsource package
let EventSourceClass: new (url: string, init?: EventSourceInit) => EventSource;

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

// Event types emitted by PlexEventSource
export interface PlexEventSourceEvents {
  'session:playing': PlexPlaySessionNotification;
  'session:paused': PlexPlaySessionNotification;
  'session:stopped': PlexPlaySessionNotification;
  'session:progress': PlexPlaySessionNotification;
  'connection:state': SSEConnectionState;
  'connection:error': Error;
}

/**
 * PlexEventSource - Manages SSE connection to a Plex server
 *
 * @example
 * const sse = new PlexEventSource({
 *   serverId: 'abc123',
 *   url: 'http://plex.local:32400',
 *   token: 'encrypted-token',
 * });
 *
 * sse.on('session:playing', (notification) => {
 *   console.log('Session started:', notification.sessionKey);
 * });
 *
 * await sse.connect();
 */
export class PlexEventSource extends EventEmitter {
  private readonly serverId: string;
  private readonly serverName: string;
  private readonly baseUrl: string;
  private readonly token: string;

  private eventSource: EventSource | null = null;
  private state: SSEConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastEventTime: Date | null = null;
  private connectedAt: Date | null = null;
  private lastError: Error | null = null;

  constructor(config: { serverId: string; serverName: string; url: string; token: string }) {
    super();
    this.serverId = config.serverId;
    this.serverName = config.serverName;
    this.baseUrl = config.url.replace(/\/$/, '');
    this.token = config.token;
  }

  /**
   * Get current connection state
   */
  getState(): SSEConnectionState {
    return this.state;
  }

  /**
   * Get connection status for monitoring
   */
  getStatus(): {
    serverId: string;
    serverName: string;
    state: SSEConnectionState;
    connectedAt: Date | null;
    lastEventAt: Date | null;
    reconnectAttempts: number;
    error: string | null;
  } {
    return {
      serverId: this.serverId,
      serverName: this.serverName,
      state: this.state,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventTime,
      reconnectAttempts: this.reconnectAttempts,
      error: this.lastError?.message ?? null,
    };
  }

  /**
   * Connect to Plex SSE endpoint
   */
  async connect(): Promise<void> {
    // Lazy load eventsource package
    if (!EventSourceClass) {
      const module = await import('eventsource');
      // eventsource v4 exports EventSource as a named export
      EventSourceClass = module.EventSource as unknown as typeof EventSourceClass;
    }

    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.setState('connecting');
    this.clearTimers();

    try {
      // Plex SSE requires token as query param (headers may not work with EventSource)
      const url = `${this.baseUrl}/:/eventsource/notifications?X-Plex-Token=${encodeURIComponent(this.token)}`;
      const headers = plexHeaders(this.token);

      console.log(
        `[SSE] Connecting to ${this.serverName} at ${this.baseUrl}/:/eventsource/notifications`
      );

      this.eventSource = new EventSourceClass(url, {
        headers,
      });

      this.eventSource.onopen = () => {
        console.log(`[SSE] Connected to ${this.serverName}`);
        this.setState('connected');
        this.connectedAt = new Date();
        this.reconnectAttempts = 0;
        this.lastError = null;
        this.startHeartbeatMonitor();
      };

      // eventsource v4 requires addEventListener instead of onmessage
      // Plex sends named 'playing' events for all playback notifications
      this.eventSource.addEventListener('message', (event: EventSourceMessage) => {
        this.handleMessage(event);
      });

      this.eventSource.addEventListener('playing', (event: EventSourceMessage) => {
        this.handleMessage(event);
      });

      this.eventSource.addEventListener('notification', (event: EventSourceMessage) => {
        this.handleMessage(event);
      });

      this.eventSource.onerror = (error: Event) => {
        this.handleError(error);
      };
    } catch (error) {
      this.handleError(error as Error);
    }
  }

  /**
   * Disconnect from SSE
   */
  disconnect(): void {
    console.log(`[SSE] Disconnecting from ${this.serverName}`);
    this.clearTimers();

    if (this.eventSource) {
      this.eventSource.onopen = null;
      this.eventSource.onerror = null;
      // Note: addEventListener listeners are cleaned up when close() is called
      this.eventSource.close();
      this.eventSource = null;
    }

    this.setState('disconnected');
    this.connectedAt = null;
  }

  /**
   * Handle incoming SSE message
   */
  private handleMessage(event: EventSourceMessage): void {
    this.lastEventTime = new Date();
    this.resetHeartbeatMonitor();

    if (!event.data) {
      return;
    }

    try {
      const data = JSON.parse(event.data) as Record<string, unknown>;

      // Plex SSE has two formats:
      // 1. Named events ('playing'): { PlaySessionStateNotification: { sessionKey, state, ... } }
      // 2. Message events: { NotificationContainer: { type, PlaySessionStateNotification: [...] } }

      // Handle direct PlaySessionStateNotification (named 'playing' events)
      if ('PlaySessionStateNotification' in data && !('NotificationContainer' in data)) {
        const notification = data.PlaySessionStateNotification as PlexPlaySessionNotification;
        this.handlePlaySessionNotification(notification, 'playing');
        return;
      }

      // Handle wrapped NotificationContainer format (legacy/message events)
      const container = (data as unknown as PlexSSENotification).NotificationContainer;
      if (container?.PlaySessionStateNotification) {
        const notifications = Array.isArray(container.PlaySessionStateNotification)
          ? container.PlaySessionStateNotification
          : [container.PlaySessionStateNotification];
        for (const notification of notifications) {
          this.handlePlaySessionNotification(notification, container.type);
        }
      }
    } catch (error) {
      console.error(`[SSE] Failed to parse message from ${this.serverName}:`, error);
    }
  }

  /**
   * Handle play session notification
   *
   * NOTE: Plex sends all playback events as container.type='playing'.
   * The actual state (playing/paused/stopped) is in notification.state.
   * See: https://www.plexopedia.com/plex-media-server/api/server/listen-events/
   */
  private handlePlaySessionNotification(
    notification: PlexPlaySessionNotification,
    _eventType: string
  ): void {
    // Use notification.state for the actual playback state
    // container.type is often 'playing' for ALL playback events
    switch (notification.state) {
      case 'playing':
        this.emit('session:playing', notification);
        break;
      case 'paused':
        this.emit('session:paused', notification);
        break;
      case 'stopped':
        this.emit('session:stopped', notification);
        break;
      case 'buffering':
        // Treat buffering as playing (will resume shortly)
        this.emit('session:playing', notification);
        break;
    }
  }

  /**
   * Handle connection error
   */
  private handleError(error: unknown): void {
    let errorMessage = 'Connection error';

    if (error instanceof Error) {
      errorMessage = error.message;
      // Log full error for debugging
      console.error(`[SSE] Full error on ${this.serverName}:`, error);
    } else if (typeof error === 'object' && error !== null) {
      // EventSource error events may have additional info
      const errorObj = error as Record<string, unknown>;
      if ('message' in errorObj) {
        errorMessage = String(errorObj.message);
      }
      if ('status' in errorObj) {
        errorMessage += ` (status: ${errorObj.status})`;
      }
      console.error(`[SSE] Error event on ${this.serverName}:`, JSON.stringify(errorObj, null, 2));
    }

    this.lastError = error instanceof Error ? error : new Error(errorMessage);

    console.error(`[SSE] Error on ${this.serverName}:`, errorMessage);
    this.emit('connection:error', this.lastError);

    // Clean up current connection
    if (this.eventSource) {
      this.eventSource.onopen = null;
      this.eventSource.onerror = null;
      // Note: addEventListener listeners are cleaned up when close() is called
      this.eventSource.close();
      this.eventSource = null;
    }

    // Attempt reconnection with exponential backoff
    this.scheduleReconnect();
  }

  /**
   * Schedule a reconnection attempt
   */
  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= SSE_CONFIG.MAX_RETRIES) {
      console.error(
        `[SSE] Max retries (${SSE_CONFIG.MAX_RETRIES}) reached for ${this.serverName}, falling back to polling`
      );
      this.setState('fallback');
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    // Exponential backoff with jitter
    const baseDelay = Math.min(
      SSE_CONFIG.INITIAL_RETRY_DELAY_MS *
        Math.pow(SSE_CONFIG.RETRY_MULTIPLIER, this.reconnectAttempts - 1),
      SSE_CONFIG.MAX_RETRY_DELAY_MS
    );
    const jitter = Math.random() * 1000; // Add up to 1s jitter
    const delay = baseDelay + jitter;

    console.log(
      `[SSE] Reconnecting to ${this.serverName} in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${SSE_CONFIG.MAX_RETRIES})`
    );

    this.reconnectTimer = setTimeout(() => {
      void this.connect();
    }, delay);
  }

  /**
   * Start heartbeat monitor
   * If we don't receive any events for HEARTBEAT_TIMEOUT_MS, consider connection dead
   */
  private startHeartbeatMonitor(): void {
    this.resetHeartbeatMonitor();
  }

  /**
   * Reset heartbeat timer (called on each message)
   */
  private resetHeartbeatMonitor(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }

    this.heartbeatTimer = setTimeout(() => {
      console.warn(`[SSE] Heartbeat timeout on ${this.serverName}, reconnecting`);
      this.handleError(new Error('Heartbeat timeout'));
    }, SSE_CONFIG.HEARTBEAT_TIMEOUT_MS);
  }

  /**
   * Clear all timers
   */
  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  /**
   * Update and emit connection state
   */
  private setState(state: SSEConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('connection:state', state);
    }
  }
}
