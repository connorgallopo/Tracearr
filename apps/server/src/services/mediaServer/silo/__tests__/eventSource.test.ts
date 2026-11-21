import { channel } from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest';
import silo from '../../../../test/mediaServerResponses/silo.json' with { type: 'json' };
import { HttpClientError } from '../../../../utils/http.js';
import { SiloClient } from '../client.js';
import { SiloEventSource } from '../eventSource.js';

const KEY = 'silo_7c2e9f4a1b6d3e8f';

/** Stands in for the server end of the socket: records how it was opened, replays frames and closes. */
class FakeSocket {
  static opened: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {
    FakeSocket.opened.push(this);
  }

  close(code = 1000, reason = ''): void {
    this.onclose?.({ code, reason });
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  ping(): void {
    channel('undici:websocket:ping').publish({ websocket: this, payload: Buffer.alloc(0) });
  }
}

/** Silo documents catalog.item.changed but none could be recorded without changing files on the server */
const itemChanged = (change: string) => ({
  ...silo.socket.catalogLibraryDisabled,
  event: 'catalog.item.changed',
  data: { library_id: '1', content_id: 'movie-imdb-tt16539454', change },
});

const flush = () => vi.advanceTimersByTimeAsync(0);

async function connected(source: SiloEventSource): Promise<FakeSocket> {
  void source.connect();
  await flush();
  const socket = FakeSocket.opened.at(-1);
  if (!socket) throw new Error('no socket opened');
  socket.receive(silo.socket.hello);
  socket.receive(silo.socket.subscribed);
  return socket;
}

function counter(source: SiloEventSource, event: string) {
  const listener = vi.fn();
  source.on(event, listener);
  return listener;
}

describe('SiloEventSource', () => {
  let source: SiloEventSource;
  let getSocketTicket: MockInstance<SiloClient['getSocketTicket']>;
  let log: MockInstance<typeof console.log>;
  let logError: MockInstance<typeof console.error>;

  beforeEach(() => {
    vi.useFakeTimers();
    log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.opened = [];
    let minted = 0;
    getSocketTicket = vi
      .spyOn(SiloClient.prototype, 'getSocketTicket')
      .mockImplementation(async () => ({
        ticket: `ticket-${++minted}`,
        expires_in: 30,
        max_connection_seconds: 14400,
        protocol: 'silo.events.v2',
      }));
    source = new SiloEventSource({
      serverId: 'silo-1',
      serverName: 'Silo',
      url: 'http://silo.local:8090/',
      token: KEY,
    });
  });

  afterEach(() => {
    source.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opens the socket with a fresh ticket in its protocols, declaring the sessions, downloads and catalog channels', async () => {
    void source.connect();
    await flush();
    const socket = FakeSocket.opened[0];

    expect(socket?.url).toBe(
      'ws://silo.local:8090/api/v2/events/ws?channels=sessions,downloads,catalog'
    );
    expect(socket?.protocols).toEqual(['silo.events.v2', 'silo.ticket.ticket-1']);
    socket?.receive(silo.socket.hello);
    expect(source.getState()).toBe('connecting');
    socket?.receive(silo.socket.subscribed);
    expect(source.getState()).toBe('connected');

    socket?.close(4004, 'authority_unavailable');
    const logged = JSON.stringify([...log.mock.calls, ...logError.mock.calls]);
    expect(logged).not.toContain('ticket-1');
    expect(logged).not.toContain(KEY);
    expect(source.getStatus().error).not.toContain('ticket-1');
  });

  it("reads sessions and downloads again on the subscribe snapshots, and nothing on the catalog's", async () => {
    const socket = await connected(source);
    const sessions = counter(source, 'sessions:changed');
    const downloads = counter(source, 'downloads:changed');
    const library = counter(source, 'library:changed');

    socket.receive(silo.socket.snapshotSessions);
    socket.receive(silo.socket.snapshotDownloads);
    socket.receive(silo.socket.snapshotCatalog);

    expect(sessions).toHaveBeenCalledTimes(1);
    expect(downloads).toHaveBeenCalledTimes(1);
    expect(library).not.toHaveBeenCalled();
  });

  it('asks for the session list on every session frame but a stop', async () => {
    const socket = await connected(source);
    const sessions = counter(source, 'sessions:changed');
    const stops = counter(source, 'session:stopped');

    socket.receive(silo.socket.sessionStarted);
    socket.receive(silo.socket.sessionsReplaced);
    socket.receive(silo.socket.sessionPaused);
    socket.receive(silo.socket.sessionResumed);

    expect(sessions).toHaveBeenCalledTimes(4);
    expect(stops).not.toHaveBeenCalled();
  });

  it('passes on a stop with the position Silo recorded, and whether an administrator ended it', async () => {
    const socket = await connected(source);
    const sessions = counter(source, 'sessions:changed');
    const stops = counter(source, 'session:stopped');

    socket.receive(silo.socket.sessionStoppedByUser);
    socket.receive(silo.socket.sessionTerminated);

    expect(stops.mock.calls).toEqual([
      [
        {
          sessionId: '191209dd-2c10-4820-839e-6051db742d19',
          positionMs: 3000,
          stoppedByAdmin: false,
        },
      ],
      [
        {
          sessionId: '6b60c113-c02d-4af0-97de-a04a22f60fce',
          positionMs: 9000,
          stoppedByAdmin: true,
        },
      ],
    ]);
    expect(sessions).not.toHaveBeenCalled();
  });

  it('says downloads changed for each download event', async () => {
    const socket = await connected(source);
    const downloads = counter(source, 'downloads:changed');

    socket.receive(silo.socket.downloadCreated);
    socket.receive(silo.socket.downloadRemoved);

    expect(downloads).toHaveBeenCalledTimes(2);
  });

  it('says the library changed for an item added or removed, and for a library turned off or on', async () => {
    const socket = await connected(source);
    const library = counter(source, 'library:changed');

    socket.receive(itemChanged('added'));
    socket.receive(itemChanged('removed'));
    socket.receive(silo.socket.catalogLibraryDisabled);
    socket.receive(silo.socket.catalogLibraryEnabled);

    expect(library).toHaveBeenCalledTimes(4);
  });

  it('asks for no library sync on catalog frames an incremental sync cannot use or that repeat item changes', async () => {
    const socket = await connected(source);
    const library = counter(source, 'library:changed');

    socket.receive(itemChanged('files_changed'));
    socket.receive(itemChanged('metadata_updated'));
    socket.receive(silo.socket.libraryChanged);
    socket.receive({
      ...silo.socket.catalogLibraryEnabled,
      data: { ...silo.socket.catalogLibraryEnabled.data, reason: 'scan' },
    });

    expect(library).not.toHaveBeenCalled();
  });

  it('falls back when Silo refuses the sessions channel', async () => {
    void source.connect();
    await flush();
    FakeSocket.opened[0]?.receive({
      ...silo.socket.subscribed,
      channels: ['downloads', 'catalog'],
    });

    expect(source.getState()).toBe('fallback');
  });

  it.each([4001, 4003])('mints a new ticket and reconnects at once after %i', async (code) => {
    const socket = await connected(source);

    if (code === 4001) socket.receive(silo.socket.accessChanged);
    socket.close(code, code === 4001 ? 'access_changed' : 'lifetime_ended');
    await flush();

    expect(getSocketTicket).toHaveBeenCalledTimes(2);
    expect(FakeSocket.opened).toHaveLength(2);
    expect(FakeSocket.opened[1]?.protocols).toContain('silo.ticket.ticket-2');
  });

  it('falls back on 4002 and opens nothing until the fallback re-probe', async () => {
    const socket = await connected(source);
    const errors = counter(source, 'connection:error');

    socket.close(4002, 'credential_invalid');

    expect(source.getState()).toBe('fallback');
    expect(errors).toHaveBeenCalledTimes(1);
    expect(source.getStatus().error).toContain('4002');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(getSocketTicket).toHaveBeenCalledTimes(2);
  });

  it.each([4004, 1006])('backs off before reconnecting after %i', async (code) => {
    const socket = await connected(source);

    socket.close(code, '');

    expect(source.getState()).toBe('reconnecting');
    await flush();
    expect(FakeSocket.opened).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it.each([401, 403])(
    'falls back without opening a socket when Silo refuses the ticket with %i',
    async (statusCode) => {
      getSocketTicket.mockRejectedValue(
        new HttpClientError({ service: 'silo', statusCode, statusText: '', url: '' })
      );

      void source.connect();
      await flush();

      expect(source.getState()).toBe('fallback');
      expect(FakeSocket.opened).toHaveLength(0);
    }
  );

  it('backs off when Silo cannot check the key yet (503)', async () => {
    getSocketTicket.mockRejectedValue(
      new HttpClientError({ service: 'silo', statusCode: 503, statusText: '', url: '' })
    );

    void source.connect();
    await flush();

    expect(source.getState()).toBe('reconnecting');
  });

  it('opens nothing when disconnected while the ticket was on its way', async () => {
    void source.connect();
    source.disconnect();
    await flush();

    expect(FakeSocket.opened).toHaveLength(0);
    expect(source.getState()).toBe('disconnected');
  });

  it('opens one socket when a ticket arrives after its attempt timed out and the next began', async () => {
    let answerLate: (ticket: Awaited<ReturnType<SiloClient['getSocketTicket']>>) => void = () => {};
    getSocketTicket.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answerLate = resolve;
        })
    );

    void source.connect();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(source.getState()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.opened).toHaveLength(1);
    answerLate({
      ticket: 'ticket-late',
      expires_in: 30,
      max_connection_seconds: 14400,
      protocol: 'silo.events.v2',
    });
    await flush();

    expect(FakeSocket.opened).toHaveLength(1);
  });

  it('treats a socket that stops pinging as dropped, and stays connected while Silo pings', async () => {
    const socket = await connected(source);

    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(20_000);
      socket.ping();
    }
    expect(source.getState()).toBe('connected');

    await vi.advanceTimersByTimeAsync(49_000);
    expect(source.getState()).toBe('connected');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(source.getState()).toBe('reconnecting');
  });

  it('ignores frames that are not objects and stays connected', async () => {
    const socket = await connected(source);

    for (const frame of [null, 42, 'event', []]) {
      expect(() => socket.receive(frame)).not.toThrow();
    }

    expect(source.getState()).toBe('connected');
  });
});
