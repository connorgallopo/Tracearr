/**
 * The lifecycle of a server's own events socket: the connection and idle timeouts, reconnect with
 * backoff, fallback to polling and its re-probe, and the connection:state and connection:error
 * events sseManager listens to. Each server opens its socket and reads its frames and closes.
 */

import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { EventEmitter } from 'events';
import { SSE_CONFIG, type SSEConnectionState, type SSEConnectionStatus } from '@tracearr/shared';

// Re-probe cadence once the reconnect budget is spent or the key is refused; polling covers data meanwhile
const FALLBACK_RETRY_MS = 3 * 60 * 1000;

// Node's WebSocket answers pings itself and reports them only on undici's diagnostics channel
const PING_CHANNEL = 'undici:websocket:ping';

export abstract class SocketEventSource<Frame extends object> extends EventEmitter {
  private readonly serverId: string;
  protected readonly serverName: string;
  protected readonly logPrefix: string;
  private readonly idleTimeoutMs: number;

  private socket: WebSocket | null = null;
  private state: SSEConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private connectionTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastEventTime: Date | null = null;
  private connectedAt: Date | null = null;
  private lastError: Error | null = null;

  protected constructor(config: {
    serverId: string;
    serverName: string;
    logPrefix: string;
    idleTimeoutMs: number;
  }) {
    super();
    this.serverId = config.serverId;
    this.serverName = config.serverName;
    this.logPrefix = config.logPrefix;
    this.idleTimeoutMs = config.idleTimeoutMs;
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

  abstract connect(): Promise<void>;

  disconnect(): void {
    console.log(`${this.logPrefix} Disconnecting from ${this.serverName}`);
    this.clearTimers();
    this.closeSocket();
    this.setState('disconnected');
    this.connectedAt = null;
  }

  retryFromFallback(): void {
    if (this.state !== 'fallback') return;
    console.log(
      `${this.logPrefix} Poll reached ${this.serverName}, retrying its socket from fallback`
    );
    this.clearTimers();
    this.reconnectAttempts = 0;
    void this.connect();
  }

  /** False when already connected or connecting; otherwise enters connecting, clears the timers and starts the connection timeout */
  protected startConnecting(target: string): boolean {
    if (this.state === 'connected' || this.state === 'connecting') {
      return false;
    }

    this.setState('connecting');
    this.clearTimers();
    console.log(`${this.logPrefix} Connecting to ${this.serverName} at ${target}`);
    this.startConnectionTimeout();
    return true;
  }

  /** Opens the socket; frames are parsed and handed to handleFrame, closes to handleClose, and frames and pings keep it alive */
  protected attach(create: () => WebSocket, onOpen?: (socket: WebSocket) => void): void {
    try {
      const socket = create();
      this.socket = socket;
      subscribe(PING_CHANNEL, this.onPing);
      socket.onopen = () => onOpen?.(socket);
      socket.onmessage = (message: MessageEvent) => this.handleMessage(String(message.data));
      socket.onclose = (event: CloseEvent) => this.handleClose(event);
    } catch (error) {
      this.handleError(error);
    }
  }

  protected markConnected(): void {
    this.clearConnectionTimeout();
    console.log(`${this.logPrefix} Connected to ${this.serverName}`);
    this.connectedAt = new Date();
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.setState('connected');
  }

  /** The server refused the credential: no backoff, polling until the fallback re-probe */
  protected refuse(error: Error): void {
    this.clearTimers();
    this.closeSocket();
    this.lastError = error;
    console.error(`${this.logPrefix} ${this.lastError.message} on ${this.serverName}`);
    this.emit('connection:error', this.lastError);
    this.enterFallback();
  }

  protected handleError(error: unknown): void {
    this.clearTimers();
    this.lastError = error instanceof Error ? error : new Error('Connection error');
    console.error(`${this.logPrefix} Error on ${this.serverName}: ${this.lastError.message}`);
    this.emit('connection:error', this.lastError);
    this.closeSocket();
    this.scheduleReconnect();
  }

  /** Reconnects with no delay, for a close the server says to answer at once */
  protected reconnectNow(reason: string): void {
    this.clearTimers();
    this.closeSocket();
    console.log(`${this.logPrefix} ${reason} on ${this.serverName}, reconnecting`);
    this.setState('reconnecting');
    void this.connect();
  }

  protected abstract handleFrame(frame: Frame): void;

  protected abstract handleClose(event: CloseEvent): void;

  private handleMessage(data: string): void {
    this.lastEventTime = new Date();
    this.resetIdleTimer();

    let frame: Frame | null;
    try {
      frame = JSON.parse(data) as Frame | null;
    } catch (error) {
      console.error(
        `${this.logPrefix} Failed to parse a socket frame from ${this.serverName}:`,
        error
      );
      return;
    }
    if (typeof frame !== 'object' || frame === null || Array.isArray(frame)) {
      console.error(
        `${this.logPrefix} Ignored a socket frame from ${this.serverName} that is not an object`
      );
      return;
    }

    this.handleFrame(frame);
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= SSE_CONFIG.MAX_RETRIES) {
      console.error(
        `${this.logPrefix} Max retries (${SSE_CONFIG.MAX_RETRIES}) reached for ${this.serverName}, falling back to polling`
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
      `${this.logPrefix} Reconnecting to ${this.serverName} in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${SSE_CONFIG.MAX_RETRIES})`
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
      console.log(`${this.logPrefix} Retrying the socket for ${this.serverName} from fallback`);
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
    }, this.idleTimeoutMs);
  }

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
