import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { WS_EVENTS, type ActiveSession, type AuthUser } from '@tracearr/shared';

const { deleteUserSessions } = vi.hoisted(() => ({ deleteUserSessions: vi.fn() }));

vi.mock('../../lib/sessionResolver.js', () => ({ resolveBetterAuthSession: vi.fn() }));
vi.mock('../../db/client.js', () => ({ db: { select: vi.fn() } }));
vi.mock('../../lib/auth.js', () => ({
  getAuth: () => ({ $context: Promise.resolve({ internalAdapter: { deleteUserSessions } }) }),
}));
vi.mock('../../lib/scope.js', () => ({ clearScope: vi.fn(), ACCESS_CACHE_TTL_MS: 30_000 }));
vi.mock('../../services/cache.js', () => ({ getPubSubService: vi.fn(() => null) }));
vi.mock('../../services/mediaServer/index.js', () => ({ JellyfinClient: {}, EmbyClient: {} }));

import { db } from '../../db/client.js';
import { resolveBetterAuthSession } from '../../lib/sessionResolver.js';
import { revokeSessionsForUsers } from '../../lib/revoke.js';
import { getPubSubService } from '../../services/cache.js';
import { queryChain } from '../../test/helpers.js';
import {
  broadcastSessionEvent,
  broadcastSessionStopped,
  disconnectMobileDevice,
  disconnectUserSockets,
  dropMobileDeviceSockets,
  dropUserSockets,
  initializeWebSocket,
} from '../index.js';

const USERS: Record<string, AuthUser> = {
  owner: { userId: 'u-owner', username: 'owner', role: 'owner', serverIds: ['srv-1'] },
  admin: { userId: 'u-admin', username: 'admin', role: 'admin', serverIds: ['srv-1'] },
  alice: { userId: 'u-alice', username: 'alice', role: 'member', serverIds: [] },
  bob: { userId: 'u-bob', username: 'bob', role: 'member', serverIds: [] },
  carol: { userId: 'u-carol', username: 'carol', role: 'member', serverIds: [] },
  viewAsAlice: {
    userId: 'u-alice',
    username: 'alice',
    role: 'member',
    serverIds: [],
    impersonatedBy: 'u-owner',
  },
};

let httpServer: HttpServer;
let io: ReturnType<typeof initializeWebSocket>;
let url: string;
const clients: Socket[] = [];

async function connectAs(name: keyof typeof USERS): Promise<Socket> {
  const client = connect(url, { auth: { token: name }, reconnection: false });
  clients.push(client);
  await new Promise<void>((resolve) => client.once('connect', () => resolve()));
  return client;
}

function roomsOf(client: Socket): string[] {
  const socket = client.id ? io.sockets.sockets.get(client.id) : undefined;
  return [...(socket?.rooms ?? [])].filter((room) => room !== client.id).sort();
}

function received(client: Socket, event: string): Promise<unknown[]> {
  const seen: unknown[] = [];
  client.on(event, (payload: unknown) => seen.push(payload));
  return new Promise((resolve) => setTimeout(() => resolve(seen), 50));
}

const session = { id: 'sess-1', serverId: 'srv-1', serverUserId: 'su-alice' } as ActiveSession;

beforeAll(async () => {
  httpServer = createServer();
  io = initializeWebSocket(httpServer);
  await new Promise<void>((resolve) => httpServer.listen(0, resolve));
  url = `http://localhost:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await io.close();
});

beforeEach(() => {
  vi.mocked(resolveBetterAuthSession).mockImplementation(async (headers) => {
    const name = headers.get('authorization')?.slice('Bearer '.length) ?? '';
    const user = USERS[name];
    return user ? { sessionId: undefined, user } : null;
  });
  vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ userId: 'u-alice' }]));
});

afterEach(() => {
  for (const client of clients.splice(0)) client.disconnect();
});

describe('socket rooms', () => {
  it('puts owner and admin in the sessions and server rooms', async () => {
    const owner = await connectAs('owner');
    expect(roomsOf(owner)).toEqual(['server:srv-1', 'sessions', 'user:u-owner']);
  });

  it('puts a member only in their own member room, and keeps them out of sessions on request', async () => {
    const alice = await connectAs('alice');
    alice.emit(WS_EVENTS.SUBSCRIBE_SESSIONS);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(roomsOf(alice)).toEqual(['member:u-alice', 'user:u-alice']);
  });

  it('puts an owner viewing as a member in that member room, not sessions', async () => {
    const viewing = await connectAs('viewAsAlice');
    expect(roomsOf(viewing)).toEqual(['member:u-alice', 'user:u-alice']);
  });
});

describe('session fan-out', () => {
  it('sends a session to the sessions room and to its owner only', async () => {
    const owner = await connectAs('owner');
    const alice = await connectAs('alice');
    const bob = await connectAs('bob');
    const ownerSeen = received(owner, WS_EVENTS.SESSION_STARTED);
    const aliceSeen = received(alice, WS_EVENTS.SESSION_STARTED);
    const bobSeen = received(bob, WS_EVENTS.SESSION_STARTED);

    await broadcastSessionEvent('session:started', session);

    expect(await ownerSeen).toEqual([session]);
    expect(await aliceSeen).toEqual([session]);
    expect(await bobSeen).toEqual([]);
  });

  it('routes a stop, which carries only the id, to the member who owned the session', async () => {
    const owner = await connectAs('owner');
    const alice = await connectAs('alice');
    const bob = await connectAs('bob');
    await broadcastSessionEvent('session:updated', session);
    const ownerSeen = received(owner, WS_EVENTS.SESSION_STOPPED);
    const aliceSeen = received(alice, WS_EVENTS.SESSION_STOPPED);
    const bobSeen = received(bob, WS_EVENTS.SESSION_STOPPED);

    void broadcastSessionStopped('sess-1');

    expect(await ownerSeen).toEqual(['sess-1']);
    expect(await aliceSeen).toEqual(['sess-1']);
    expect(await bobSeen).toEqual([]);
  });

  it('never lets a stop overtake the start whose owner is still being looked up', async () => {
    const alice = await connectAs('alice');
    const order: string[] = [];
    alice.on(WS_EVENTS.SESSION_STARTED, () => order.push('started'));
    alice.on(WS_EVENTS.SESSION_STOPPED, () => order.push('stopped'));
    const slow = queryChain(vi.fn, [{ userId: 'u-alice' }]);
    slow.limit = () =>
      new Promise((resolve) => setTimeout(() => resolve([{ userId: 'u-alice' }]), 30));
    vi.mocked(db.select).mockReturnValue(slow);
    const fresh = { ...session, id: 'sess-slow', serverUserId: 'su-slow' } as ActiveSession;

    const started = broadcastSessionEvent('session:started', fresh);
    const stopped = broadcastSessionStopped('sess-slow');
    await Promise.all([started, stopped]);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(order).toEqual(['started', 'stopped']);
  });

  it('follows an account to its new person after a split, not the person it left', async () => {
    await connectAs('alice');
    const carol = await connectAs('carol');
    const split = { ...session, id: 'sess-split', serverUserId: 'su-split' } as ActiveSession;
    await broadcastSessionEvent('session:updated', split);
    await new Promise((resolve) => setTimeout(resolve, 30));

    // splitServerUser repoints the account at a new person and revokes both, which publishes
    // the access change every instance relays to dropUserSockets.
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, [{ userId: 'u-carol' }]));
    dropUserSockets('u-alice');
    const alice = await connectAs('alice');
    const aliceSeen = received(alice, WS_EVENTS.SESSION_UPDATED);
    const carolSeen = received(carol, WS_EVENTS.SESSION_UPDATED);

    await broadcastSessionEvent('session:updated', split);

    expect(await aliceSeen).toEqual([]);
    expect(await carolSeen).toEqual([split]);
  });
});

describe('revocation', () => {
  it('drops an admin socket when the admin is revoked, as on a demotion to member', async () => {
    const admin = await connectAs('admin');
    vi.mocked(db.select).mockReturnValue(queryChain(vi.fn, []));
    const dropped = new Promise((resolve) => admin.once('disconnect', resolve));

    await revokeSessionsForUsers(['u-admin']);

    expect(await dropped).toBe('io server disconnect');
    expect(deleteUserSessions).toHaveBeenCalledWith('u-admin');
  });

  it('publishes the access change so every instance drops the sockets it holds', async () => {
    const admin = await connectAs('admin');
    const publish = vi.fn();
    vi.mocked(getPubSubService).mockReturnValueOnce({ publish } as never);

    await disconnectUserSockets('u-admin');

    expect(publish).toHaveBeenCalledExactlyOnceWith(WS_EVENTS.USER_ACCESS_CHANGED, 'u-admin');
    expect(admin.connected).toBe(true);
    const dropped = new Promise((resolve) => admin.once('disconnect', resolve));
    dropUserSockets('u-admin');
    expect(await dropped).toBe('io server disconnect');
  });

  it('publishes a mobile device revoke so every instance drops that device', async () => {
    const publish = vi.fn();
    vi.mocked(getPubSubService).mockReturnValueOnce({ publish } as never);

    await disconnectMobileDevice('device-1');

    expect(publish).toHaveBeenCalledExactlyOnceWith(WS_EVENTS.MOBILE_DEVICE_REVOKED, 'device-1');
    expect(() => dropMobileDeviceSockets('device-1')).not.toThrow();
  });
});
