/**
 * Silo Event Source
 *
 * Holds Silo's events socket at /api/v2/events/ws. Each connection needs a fresh single-use
 * ticket, minted with the API key and offered as a subprotocol, so the URL never carries a
 * credential. The channels are declared on the URL; Silo answers hello, subscribed and a
 * snapshot per channel. Session frames cue a read of the session list, except a stop, which
 * carries the position Silo recorded. Download frames cue a download read, and some catalog
 * frames a library sync. Silo pings every 20 s and says in its close code what to do next.
 */

import { isHttpStatus } from '../../../utils/http.js';
import { SocketEventSource } from '../shared/socketEventSource.js';
import { SiloClient } from './client.js';
import type { SiloCatalogChange, SiloSessionStopped, SiloSocketFrame } from './types.js';

// Two of Silo's 20 s pings plus slack
const IDLE_TIMEOUT_MS = 50 * 1000;

export interface SiloSessionStop {
  sessionId: string;
  positionMs: number | null;
  stoppedByAdmin: boolean;
}

/** Null for anything but a stop that names its session */
function stopOf(frame: SiloSocketFrame): SiloSessionStop | null {
  if (frame.event !== 'session.stopped') return null;
  const data = frame.data as Partial<SiloSessionStopped> | null | undefined;
  if (typeof data?.session_id !== 'string') return null;
  const seconds: unknown = data.history?.end_position_seconds;
  return {
    sessionId: data.session_id,
    positionMs:
      typeof seconds === 'number' && Number.isFinite(seconds) ? Math.round(seconds * 1000) : null,
    stoppedByAdmin: data.end_reason === 'terminated',
  };
}

/**
 * Only what a Silo library sync can act on. An incremental sync lists new items alone, and a
 * removal or a library turned off drops the count, which makes the sync a full scan. An
 * incremental sync cannot see file or metadata edits, so those wait for the next full scan; a
 * scan's own summary and the legacy event names repeat item events Silo already sent.
 */
function isLibraryChange(frame: SiloSocketFrame): boolean {
  const data = frame.data as SiloCatalogChange | null | undefined;
  switch (frame.event) {
    case 'catalog.item.changed':
      return data?.change === 'added' || data?.change === 'removed';
    case 'catalog.library.changed':
      return data?.reason === 'library_enabled' || data?.reason === 'library_disabled';
    default:
      return false;
  }
}

export class SiloEventSource extends SocketEventSource<SiloSocketFrame> {
  private readonly url: string;
  private readonly token: string;
  private readonly socketUrl: string;
  private ticketRequests = 0;

  constructor(config: { serverId: string; serverName: string; url: string; token: string }) {
    super({
      serverId: config.serverId,
      serverName: config.serverName,
      logPrefix: '[silo]',
      idleTimeoutMs: IDLE_TIMEOUT_MS,
    });
    this.url = config.url;
    this.token = config.token;
    const wsBase = config.url.replace(/\/$/, '').replace(/^http/, 'ws');
    this.socketUrl = `${wsBase}/api/v2/events/ws?channels=sessions,downloads,catalog`;
  }

  /** Never rejects: a refused or failed ticket goes to the fallback or reconnect path */
  async connect(): Promise<void> {
    if (!this.startConnecting(this.socketUrl)) return;
    // A ticket can outlive its attempt (rate-limit waits run past the connection timeout)
    const request = ++this.ticketRequests;
    const current = () => request === this.ticketRequests && this.getState() === 'connecting';

    let ticket: string;
    try {
      ({ ticket } = await new SiloClient({ url: this.url, token: this.token }).getSocketTicket());
    } catch (error) {
      if (!current()) return;
      if (isHttpStatus(error, 401, 403)) {
        this.refuse(
          new Error(`Silo refused the API key for its events socket (HTTP ${error.statusCode})`)
        );
      } else {
        this.handleError(error);
      }
      return;
    }

    if (!current()) return;
    this.attach(() => new WebSocket(this.socketUrl, ['silo.events.v2', `silo.ticket.${ticket}`]));
  }

  protected handleFrame(frame: SiloSocketFrame): void {
    switch (frame.type) {
      case 'subscribed':
        if (frame.channels?.includes('sessions')) {
          this.markConnected();
        } else {
          this.refuse(new Error('Silo refused the sessions channel'));
        }
        return;
      case 'snapshot':
      case 'event':
        this.handleChannelFrame(frame);
        return;
      case 'error':
        console.error(
          `${this.logPrefix} Silo sent an error on ${this.serverName}: ${frame.code} ${frame.message}`
        );
        return;
      default:
        return;
    }
  }

  private handleChannelFrame(frame: SiloSocketFrame): void {
    switch (frame.channel) {
      case 'sessions': {
        const stop = stopOf(frame);
        if (stop) {
          this.emit('session:stopped', stop);
        } else {
          this.emit('sessions:changed');
        }
        return;
      }
      case 'downloads':
        this.emit('downloads:changed');
        return;
      case 'catalog':
        if (frame.type === 'event' && isLibraryChange(frame)) this.emit('library:changed');
        return;
      default:
        return;
    }
  }

  protected handleClose(event: CloseEvent): void {
    const { code, reason } = event;
    switch (code) {
      case 4001: // access_changed
      case 4003: // lifetime_ended
        this.reconnectNow(`Silo closed the socket (${code} ${reason})`);
        return;
      case 4002: // credential_invalid, final
        this.refuse(
          new Error(
            'Silo ended the socket: the API key or its account is gone (4002 credential_invalid)'
          )
        );
        return;
      default:
        this.handleError(new Error(`Socket closed (${code}${reason ? ` ${reason}` : ''})`));
    }
  }
}
