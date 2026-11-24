import { beforeEach, describe, expect, it } from 'vitest';
import type { ActiveSession, ViolationWithDetails } from '@tracearr/shared';
import {
  PUBLIC_EVENT_TYPES,
  clearLastSeen,
  seedLastSeen,
  translateChannelMessage,
  type PublicEvent,
  type Translated,
} from '../publicV2/eventsTranslate.js';
import { KIDS } from '../../services/notifications/__tests__/fixtures.js';

const AT = '2026-10-06T10:00:00.000Z';

function firstEvent(out: Translated | null): PublicEvent {
  if (out?.kind !== 'events') throw new Error('expected events');
  const [first] = out.events;
  if (!first) throw new Error('expected an event');
  return first;
}

function stoppedSnapshot(out: Translated | null): { id: string; state: string } | null {
  return (firstEvent(out).data as { stream: { id: string; state: string } | null }).stream;
}

const session = {
  id: 'sess-1',
  serverId: 'srv-1',
  server: { id: 'srv-1', name: 'Attic', type: 'plex' },
  user: { id: 'su-1', username: 'alice', thumbUrl: null, identityName: null },
  mediaTitle: 'Film',
  mediaType: 'movie',
  state: 'playing',
  progressMs: 1000,
  totalDurationMs: 5000,
  startedAt: '2026-10-06T10:00:00.000Z',
  bitrate: 4000,
  sourceVideoWidth: 1920,
  sourceVideoHeight: 1080,
  canTerminate: true,
} as unknown as ActiveSession;

const kidsStream = { ...session, nonMainProfile: KIDS } as unknown as ActiveSession;

const KIDS_V2 = { name: 'Kids', thumb_url: null, removed: false };

const violation = {
  id: 'v-1',
  ruleId: 'r-1',
  serverUserId: 'su-1',
  sessionId: 'sess-1',
  severity: 'high',
  data: { count: 3 },
  createdAt: new Date('2026-10-06T10:00:05.000Z'),
  acknowledgedAt: null,
  rule: { id: 'r-1', name: 'Too many streams', type: null },
  user: {
    id: 'su-1',
    userId: 'u-1',
    username: 'alice',
    thumbUrl: null,
    serverId: 'srv-1',
    identityName: 'Alice',
  },
  server: { id: 'srv-1', name: 'Attic', type: 'plex' },
} as unknown as ViolationWithDetails;

describe('translateChannelMessage', () => {
  beforeEach(() => {
    clearLastSeen();
  });

  it('exposes six public types', () => {
    expect(PUBLIC_EVENT_TYPES).toHaveLength(6);
  });

  it('maps a started session to a fat stream.started with library fields null', () => {
    const out = translateChannelMessage({ event: 'session:started', data: session, at: AT });
    expect(out?.kind).toBe('events');
    if (out?.kind !== 'events') return;
    const [ev] = out.events;
    expect(ev).toMatchObject({
      type: 'stream.started',
      at: AT,
      serverId: 'srv-1',
      streamId: 'sess-1',
    });
    expect(ev?.data).toMatchObject({
      id: 'sess-1',
      server_id: 'srv-1',
      library_id: null,
      genres: null,
      profile: null,
    });

    const kids = translateChannelMessage({ event: 'session:started', data: kidsStream, at: AT });
    expect(firstEvent(kids).data).toMatchObject({ profile: KIDS_V2 });
  });

  it('carries the last snapshot into stream.stopped and forgets it', () => {
    translateChannelMessage({ event: 'session:started', data: kidsStream, at: AT });
    const stopped = translateChannelMessage({ event: 'session:stopped', data: 'sess-1', at: AT });
    expect(firstEvent(stopped)).toMatchObject({
      type: 'stream.stopped',
      serverId: 'srv-1',
      streamId: 'sess-1',
    });
    expect(firstEvent(stopped).data).toMatchObject({ id: 'sess-1', server_id: 'srv-1' });
    expect(stoppedSnapshot(stopped)).toMatchObject({ id: 'sess-1', profile: KIDS_V2 });

    const again = translateChannelMessage({ event: 'session:stopped', data: 'sess-1', at: AT });
    if (again?.kind !== 'events') throw new Error('expected events');
    expect(again.events[0]).toMatchObject({
      serverId: null,
      data: { id: 'sess-1', server_id: null, stream: null },
    });
  });

  it('seeds snapshots for sessions it never saw start, without overwriting fresher ones', () => {
    const fresh = { ...session, state: 'paused' } as unknown as ActiveSession;
    translateChannelMessage({ event: 'session:updated', data: fresh, at: AT });
    const other = { ...session, id: 'sess-2', state: 'playing' } as unknown as ActiveSession;

    seedLastSeen([{ ...session, state: 'playing' } as unknown as ActiveSession, other]);

    const stoppedOne = translateChannelMessage({
      event: 'session:stopped',
      data: 'sess-1',
      at: AT,
    });
    expect(stoppedSnapshot(stoppedOne)?.state).toBe('paused');

    const stoppedTwo = translateChannelMessage({
      event: 'session:stopped',
      data: 'sess-2',
      at: AT,
    });
    expect(firstEvent(stoppedTwo)).toMatchObject({ serverId: 'srv-1' });
    expect(stoppedSnapshot(stoppedTwo)?.id).toBe('sess-2');
  });

  it('a cleared map lets the seed replace a stale snapshot', () => {
    translateChannelMessage({
      event: 'session:updated',
      data: { ...session, state: 'paused' } as unknown as ActiveSession,
      at: AT,
    });
    clearLastSeen();
    seedLastSeen([{ ...session, state: 'playing' } as unknown as ActiveSession]);

    const stopped = translateChannelMessage({ event: 'session:stopped', data: 'sess-1', at: AT });
    expect(stoppedSnapshot(stopped)?.state).toBe('playing');
  });

  it('expands one progress message into one slim event per session', () => {
    const out = translateChannelMessage({
      event: 'sessions:progress',
      at: AT,
      data: {
        sessions: [
          { id: 'a', serverId: 'srv-1', state: 'playing', progressMs: 10, bitrate: 1 },
          { id: 'b', serverId: 'srv-2', state: 'paused', progressMs: 20, bitrate: null },
        ],
      },
    });
    if (out?.kind !== 'events') throw new Error('expected events');
    expect(out.events.map((e) => [e.type, e.streamId, e.serverId])).toEqual([
      ['stream.progress', 'a', 'srv-1'],
      ['stream.progress', 'b', 'srv-2'],
    ]);
    expect(out.events[1]?.data).toEqual({
      id: 'b',
      server_id: 'srv-2',
      state: 'paused',
      progress_ms: 20,
      bitrate: null,
    });
  });

  it('maps a violation and server health to their public shapes', () => {
    const v = translateChannelMessage({ event: 'violation:new', data: violation, at: AT });
    if (v?.kind !== 'events') throw new Error('expected events');
    expect(v.events[0]).toMatchObject({
      type: 'violation.created',
      serverId: 'srv-1',
      streamId: 'sess-1',
    });
    expect(v.events[0]?.data).toEqual({
      id: 'v-1',
      severity: 'high',
      created_at: '2026-10-06T10:00:05.000Z',
      acknowledged_at: null,
      session_id: 'sess-1',
      rule: { id: 'r-1', name: 'Too many streams' },
      server: { id: 'srv-1', name: 'Attic', type: 'plex' },
      user: {
        id: 'u-1',
        server_user_id: 'su-1',
        username: 'Alice',
        thumb_url: null,
        avatar_url: null,
      },
      data: { count: 3 },
    });

    const down = translateChannelMessage({
      event: 'server:down',
      data: { serverId: 'srv-1', serverName: 'Attic', reason: 'unauthorized' },
      at: AT,
    });
    if (down?.kind !== 'events') throw new Error('expected events');
    expect(down.events[0]?.data).toEqual({
      server_id: 'srv-1',
      server_name: 'Attic',
      status: 'down',
      reason: 'unauthorized',
    });

    const up = translateChannelMessage({
      event: 'server:up',
      data: { serverId: 'srv-1', serverName: 'Attic' },
      at: AT,
    });
    if (up?.kind !== 'events') throw new Error('expected events');
    expect(up.events[0]?.data).toEqual({
      server_id: 'srv-1',
      server_name: 'Attic',
      status: 'up',
      reason: null,
    });
  });

  it('drops a violation whose payload lacks the identity id or the server', () => {
    const noIdentity = {
      ...violation,
      user: { ...violation.user, userId: undefined },
    } as unknown as ViolationWithDetails;
    expect(
      translateChannelMessage({ event: 'violation:new', data: noIdentity, at: AT })
    ).toBeNull();
    const noServer = { ...violation, server: undefined } as unknown as ViolationWithDetails;
    expect(translateChannelMessage({ event: 'violation:new', data: noServer, at: AT })).toBeNull();
  });

  it('turns a key change into a control result and ignores everything else', () => {
    expect(
      translateChannelMessage({ event: 'public-api:key-changed', data: { userId: 'u1' }, at: AT })
    ).toEqual({
      kind: 'key-changed',
      userId: 'u1',
    });
    expect(translateChannelMessage({ event: 'stats:updated', data: {}, at: AT })).toBeNull();
    expect(translateChannelMessage({ event: 'session:stopped', data: 42, at: AT })).toBeNull();
  });
});
