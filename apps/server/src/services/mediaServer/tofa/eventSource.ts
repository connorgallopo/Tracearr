/**
 * tofa Event Source
 *
 * Holds the socket tofa serves at /api/v1/ws. The API key goes in the first frame; tofa
 * answers auth_ok, or an error code and a closed socket. Session frames name the session
 * that changed, EventsMissed says frames were dropped, media and scan frames say a library
 * changed, and request frames say a request changed. Everything else, most of the traffic being
 * AppLog, is ignored. tofa pings every 30 s, so a socket silent for longer than two pings is
 * treated as dropped.
 */

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { EventEmitter } from 'events';
import { SSE_CONFIG, type SSEConnectionState, type SSEConnectionStatus } from '@tracearr/shared';
import { isLibraryChange, isRequestChange, parseTofaStreamEvent } from './parser.js';
import type { TofaSocketFrame } from './types.js';

// Re-probe cadence once the reconnect budget is spent or the key is refused; polling covers data meanwhile
const FALLBACK_RETRY_MS = 3 * 60 * 1000;

const IDLE_TIMEOUT_MS = 75 * 1000;

// Node's WebSocket answers pings itself and reports them only on undici's diagnostics channel
const PING_CHANNEL = 'undici:websocket:ping';

export class TofaEventSource extends EventEmitter {
  private readonly serverId: string;
  private readonly serverName: string;
  private readonly socketUrl: string;
  private readonly token: string;

  private socket: WebSocket | null = null;
  private state: SSEConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastEventTime: Date | null = null;
  private connectedAt: Date | null = null;
  private lastError: Error | null = null;

  constructor(config: { serverId: string; serverName: string; url: string; token: string }) {
    super();
    this.serverId = config.serverId;
    this.serverName = config.serverName;
    this.socketUrl = `${config.url.replace(/\/$/, '').replace(/^http/, 'ws')}/api/v1/ws`;
    this.token = config.token;
  }

  private readonly onPing = (message: unknown): void => {
    const fromThisSocket =
      typeof message === 'object' &&
      message !== null &&
      'websocket' in message &&
      message.websocket === this.socket;
    if (fromThisSocket) this.resetIdleTimer();
  };

  getState(): SSEConnectionState {
    return this.state;
  }

  getStatus(): SSEConnectionStatus {
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

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    this.setState('connecting');
    this.clearTimers();
    console.log(`[tofa] Connecting to ${this.serverName} at ${this.socketUrl}`);

    try {
      const socket = new WebSocket(this.socketUrl);
      this.socket = socket;
      subscribe(PING_CHANNEL, this.onPing);
      this.startConnectionTimeout();
      socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: this.token }));
      socket.onmessage = (message: MessageEvent) => this.handleMessage(String(message.data));
      socket.onclose = () => this.handleError(new Error('Socket closed'));
    } catch (error) {
      this.handleError(error);
    }
  }

  disconnect(): void {
    console.log(`[tofa] Disconnecting from ${this.serverName}`);
    this.clearTimers();
    this.closeSocket();
    this.setState('disconnected');
    this.connectedAt = null;
  }

  retryFromFallback(): void {
    if (this.state !== 'fallback') return;
    console.log(`[tofa] Poll reached ${this.serverName}, retrying its socket from fallback`);
    this.clearTimers();
    this.reconnectAttempts = 0;
    void this.connect();
  }

  private handleMessage(data: string): void {
    this.lastEventTime = new Date();
    this.resetIdleTimer();

    let frame: TofaSocketFrame | null;
    try {
      frame = JSON.parse(data) as TofaSocketFrame | null;
    } catch (error) {
      console.error(`[tofa] Failed to parse a socket frame from ${this.serverName}:`, error);
      return;
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
      console.error(`[tofa] Ignored a socket frame from ${this.serverName} that is not an object`);
      return;
    }

    // Only the auth error frame has no type; ScanFailed and RefreshFailed carry an error too
    if (frame.type === undefined) {
      this.refuse(frame.error);
      return;
    }
    if (frame.type === 'auth_ok') {
      this.clearConnectionTimeout();
      console.log(`[tofa] Connected to ${this.serverName}`);
      this.connectedAt = new Date();
      this.reconnectAttempts = 0;
      this.lastError = null;
      this.setState('connected');
      return;
    }

    if (isLibraryChange(frame)) {
      this.emit('library:changed');
      return;
    }
    if (isRequestChange(frame)) {
      this.emit('requests:changed');
      return;
    }
    const event = parseTofaStreamEvent(frame);
    if (event) this.emit('stream', event);
  }

  /** A refused key skips the reconnect backoff: polling takes over until the fallback re-probe. */
  private refuse(code: string): void {
    this.clearTimers();
    this.closeSocket();
    this.lastError = new Error(`tofa refused the API key on its socket (${code})`);
    console.error(`[tofa] ${this.lastError.message} on ${this.serverName}`);
    this.emit('connection:error', this.lastError);
    this.enterFallback();
  }

  private handleError(error: unknown): void {
    this.clearTimers();
    this.lastError = error instanceof Error ? error : new Error('Connection error');
    console.error(`[tofa] Error on ${this.serverName}: ${this.lastError.message}`);
    this.emit('connection:error', this.lastError);
    this.closeSocket();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= SSE_CONFIG.MAX_RETRIES) {
      console.error(
        `[tofa] Max retries (${SSE_CONFIG.MAX_RETRIES}) reached for ${this.serverName}, falling back to polling`
      );
      this.enterFallback();
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
      `[tofa] Reconnecting to ${this.serverName} in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${SSE_CONFIG.MAX_RETRIES})`
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.state === 'disconnected') return;
      void this.connect();
    }, delay);
  }

  private enterFallback(): void {
    this.setState('fallback');
    this.reconnectTimer = setTimeout(() => {
      if (this.state === 'disconnected') return;
      console.log(`[tofa] Retrying the socket for ${this.serverName} from fallback`);
      this.reconnectAttempts = 0;
      void this.connect();
    }, FALLBACK_RETRY_MS);
  }

  private closeSocket(): void {
    if (!this.socket) return;
    unsubscribe(PING_CHANNEL, this.onPing);
    this.socket.onopen = null;
    this.socket.onmessage = null;
    this.socket.onclose = null;
    this.socket.close();
    this.socket = null;
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    this.clearConnectionTimeout();
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.state === 'disconnected') return;
      this.handleError(new Error('Heartbeat timeout'));
    }, IDLE_TIMEOUT_MS);
  }

  /** tofa holds an unauthenticated socket open without a word, so a missing auth_ok is a timeout. */
  private startConnectionTimeout(): void {
    this.clearConnectionTimeout();
    this.connectionTimer = setTimeout(() => {
      if (this.state === 'disconnected') return;
      this.handleError(new Error('Connection timeout'));
    }, SSE_CONFIG.HEARTBEAT_TIMEOUT_MS);
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
