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

import { SocketEventSource } from '../shared/socketEventSource.js';
import { isLibraryChange, isRequestChange, parseTofaStreamEvent } from './parser.js';
import type { TofaSocketFrame } from './types.js';

const IDLE_TIMEOUT_MS = 75 * 1000;

export class TofaEventSource extends SocketEventSource<TofaSocketFrame> {
  private readonly socketUrl: string;
  private readonly token: string;

  constructor(config: { serverId: string; serverName: string; url: string; token: string }) {
    super({
      serverId: config.serverId,
      serverName: config.serverName,
      logPrefix: '[tofa]',
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });
    this.socketUrl = `${config.url.replace(/\/$/, '').replace(/^http/, 'ws')}/api/v1/ws`;
    this.token = config.token;
  }

  /** tofa holds an unauthenticated socket open without a word, so a missing auth_ok is a timeout. */
  async connect(): Promise<void> {
    if (!this.startConnecting(this.socketUrl)) return;
    this.attach(
      () => new WebSocket(this.socketUrl),
      (socket) => socket.send(JSON.stringify({ type: 'auth', token: this.token }))
    );
  }

  protected handleFrame(frame: TofaSocketFrame): void {
    // Only the auth error frame has no type; ScanFailed and RefreshFailed carry an error too
    if (frame.type === undefined) {
      this.refuse(new Error(`tofa refused the API key on its socket (${frame.error})`));
      return;
    }
    if (frame.type === 'auth_ok') {
      this.markConnected();
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

  protected handleClose(): void {
    this.handleError(new Error('Socket closed'));
  }
}
