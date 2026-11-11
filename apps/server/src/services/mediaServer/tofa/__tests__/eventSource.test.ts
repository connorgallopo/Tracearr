import { channel } from 'node:diagnostics_channel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tofa from '../../../../test/mediaServerResponses/tofa.json' with { type: 'json' };
import { TofaEventSource } from '../eventSource.js';

const KEY = 'tofa_8f2d6a0c1e5b7d9f';

/** Stands in for the server end of the socket: records what Tracearr sends, replays frames. */
class FakeSocket {
  static opened: FakeSocket[] = [];
  readonly sent: unknown[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((message: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.opened.push(this);
  }

  send(frame: string): void {
    this.sent.push(JSON.parse(frame));
  }

  close(): void {}

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  ping(): void {
    channel('undici:websocket:ping').publish({ websocket: this, payload: Buffer.alloc(0) });
  }
}

function connected(source: TofaEventSource): FakeSocket {
  void source.connect();
  const socket = FakeSocket.opened.at(-1);
  if (!socket) throw new Error('no socket opened');
  socket.onopen?.();
  socket.receive(tofa.socket.authOk);
  return socket;
}

describe('TofaEventSource', () => {
  let source: TofaEventSource;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('WebSocket', FakeSocket);
    FakeSocket.opened = [];
    source = new TofaEventSource({
      serverId: 'tofa-1',
      serverName: 'tofa',
      url: 'http://tofa.local:33333/',
      token: KEY,
    });
  });

  afterEach(() => {
    source.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('sends the API key as the first frame and is connected once tofa accepts it', () => {
    const socket = connected(source);

    expect(socket.url).toBe('ws://tofa.local:33333/api/v1/ws');
    expect(socket.sent).toEqual([{ type: 'auth', token: KEY }]);
    expect(source.getState()).toBe('connected');
  });

  it('falls back to polling with the code when tofa refuses the key, and does not retry at once', async () => {
    void source.connect();
    const socket = FakeSocket.opened[0];
    socket?.onopen?.();
    socket?.receive(tofa.socket.authError);

    expect(source.getState()).toBe('fallback');
    expect(source.getStatus().error).toContain('unauthorized');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.opened).toHaveLength(1);
  });

  it('replays a recorded play as one change per session frame and a stop with its position', () => {
    const socket = connected(source);
    const events: unknown[] = [];
    source.on('stream', (event) => events.push(event));

    for (const frame of [
      tofa.socket.appLog,
      tofa.socket.streamStarted,
      tofa.socket.streamProgressPlaying,
      tofa.socket.appLog,
      tofa.socket.streamProgressPaused,
      tofa.socket.streamStopped,
    ]) {
      socket.receive(frame);
    }

    const sessionId = tofa.socket.streamStarted.session_id;
    expect(events).toEqual([
      { kind: 'changed', sessionId },
      { kind: 'changed', sessionId },
      { kind: 'changed', sessionId },
      { kind: 'stopped', sessionId, positionMs: 172476, stoppedByAdmin: false },
    ]);
  });

  it('ignores frames that are not objects and stays connected', () => {
    const socket = connected(source);

    for (const frame of [null, 42, 'StreamStarted', []]) {
      expect(() => socket.receive(frame)).not.toThrow();
    }

    expect(source.getState()).toBe('connected');
  });

  it('stays connected through a failed scan, whose frame also carries an error', () => {
    const socket = connected(source);
    const changes = vi.fn();
    source.on('library:changed', changes);

    socket.receive(tofa.socket.scanFailed);

    expect(source.getState()).toBe('connected');
    expect(source.getStatus().error).toBeNull();
    expect(changes).not.toHaveBeenCalled();
  });

  it('says a library changed for media and finished scans, and nothing else', () => {
    const socket = connected(source);
    const changes = vi.fn();
    source.on('library:changed', changes);

    socket.receive(tofa.socket.mediaAdded);
    socket.receive({ ...tofa.socket.mediaAdded, type: 'MediaDeleted' });
    socket.receive(tofa.socket.scanCompleted);
    socket.receive({ type: 'ScanProgress', library_id: tofa.socket.scanCompleted.library_id });

    expect(changes).toHaveBeenCalledTimes(3);
  });

  it('says the requests changed when tofa reports one made, updated or removed', () => {
    const socket = connected(source);
    const changes = vi.fn();
    const libraryChanges = vi.fn();
    source.on('requests:changed', changes);
    source.on('library:changed', libraryChanges);

    socket.receive(tofa.socket.requestCreated);
    socket.receive(tofa.socket.requestUpdated);
    socket.receive(tofa.socket.requestDeleted);

    expect(changes).toHaveBeenCalledTimes(3);
    expect(libraryChanges).not.toHaveBeenCalled();
  });

  it('passes on that frames were missed', () => {
    const socket = connected(source);
    const events: unknown[] = [];
    source.on('stream', (event) => events.push(event));

    socket.receive({ type: 'EventsMissed', missed: 4 });

    expect(events).toEqual([{ kind: 'missed' }]);
  });

  it('reconnects and authenticates again after the socket drops', async () => {
    const first = connected(source);

    first.onclose?.();
    expect(source.getState()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(2_000);

    const second = FakeSocket.opened[1];
    second?.onopen?.();
    second?.receive(tofa.socket.authOk);
    expect(second?.sent).toEqual([{ type: 'auth', token: KEY }]);
    expect(source.getState()).toBe('connected');
  });

  it('treats a socket that stops pinging as dropped and reconnects', async () => {
    connected(source);

    await vi.advanceTimersByTimeAsync(74_000);
    expect(source.getState()).toBe('connected');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(source.getState()).toBe('reconnecting');
    expect(source.getStatus().error).toBe('Heartbeat timeout');
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.opened).toHaveLength(2);
  });

  it('stays connected while tofa pings, with no frames at all', async () => {
    const socket = connected(source);

    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(30_000);
      socket.ping();
    }

    expect(source.getState()).toBe('connected');
    expect(FakeSocket.opened).toHaveLength(1);
  });
});
