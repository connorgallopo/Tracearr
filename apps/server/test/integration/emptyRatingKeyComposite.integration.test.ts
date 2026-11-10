/**
 * JF/Emby sessions can arrive with no NowPlaying item, so mapMediaSession
 * yields an empty ratingKey (''). The DB insert and the composite dedup
 * lookups must agree on how that empty value is represented, otherwise every
 * poll tick fails to find the row it wrote on the previous tick and inserts a
 * duplicate for the same playback until the stale sweep.
 *
 * These pin the round trip: create a session with an empty ratingKey, then
 * confirm the two composite lookups used by the poller (the tick-2 dedup batch
 * and the grace-sweep confirm) both find that row.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- emptyRatingKeyComposite
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { DEFAULT_STREAM_DETAILS, type ServerType } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
} from '@tracearr/test-utils/factories';
import {
  createSessionWithRulesAtomic,
  batchFindActiveSessionsByComposite,
  findActiveSessionByComposite,
} from '../../src/jobs/poller/sessionLifecycle.js';
import { db } from '../../src/db/client.js';
import { sessions } from '../../src/db/schema.js';
import type { SessionCreationInput } from '../../src/jobs/poller/types.js';

const NULL_GEO = {
  city: null,
  region: null,
  country: null,
  countryCode: null,
  continent: null,
  postal: null,
  lat: null,
  lon: null,
  asnNumber: null,
  asnOrganization: null,
};

async function setupServerAndUser() {
  const server = await createTestServer({ type: 'jellyfin' });
  const user = await createTestUser();
  const serverUser = await createTestServerUser({ serverId: server.id, userId: user.id });
  return { server, user, serverUser };
}

function buildCreationInput(
  overrides: Partial<SessionCreationInput['processed']>,
  server: { id: string; name: string; type: ServerType },
  serverUser: { id: string; userId: string; username: string; thumbUrl: string | null }
): SessionCreationInput {
  return {
    processed: {
      sessionKey: randomUUID(),
      ratingKey: `rk-${randomUUID()}`,
      externalUserId: 'ext-user-1',
      username: serverUser.username,
      userThumb: '',
      mediaTitle: 'Test Media',
      mediaType: 'movie',
      grandparentTitle: '',
      seasonNumber: null,
      episodeNumber: null,
      year: 2024,
      thumbPath: '',
      channelTitle: null,
      channelIdentifier: null,
      channelThumb: null,
      liveUuid: null,
      artistName: null,
      albumName: null,
      trackNumber: null,
      discNumber: null,
      ipAddress: '127.0.0.1',
      playerName: 'Test Player',
      deviceId: 'device-1',
      product: 'Test Product',
      device: 'Test Device',
      platform: 'Test Platform',
      quality: '1080p',
      isTranscode: false,
      videoDecision: 'directplay',
      audioDecision: 'directplay',
      bitrate: 8000,
      state: 'playing',
      totalDurationMs: 3_600_000,
      progressMs: 0,
      ...DEFAULT_STREAM_DETAILS,
      ...overrides,
    },
    server,
    serverUser: {
      id: serverUser.id,
      userId: serverUser.userId,
      username: serverUser.username,
      thumbUrl: serverUser.thumbUrl,
      identityName: null,
      trustScore: 100,
      lastActivityAt: null,
      createdAt: new Date(),
      identityServerUserIds: [serverUser.id],
    },
    geo: NULL_GEO,
    activeAutomations: [],
    activeSessions: [],
    recentSessions: [],
  };
}

describe('empty ratingKey composite lookups match the row they inserted', () => {
  it('the tick-2 dedup batch finds a session created with an empty ratingKey', async () => {
    const { server, serverUser } = await setupServerAndUser();

    const input = buildCreationInput({ ratingKey: '', deviceId: 'device-1' }, server, serverUser);
    const { insertedSession } = await createSessionWithRulesAtomic(input);

    const batch = await batchFindActiveSessionsByComposite(server.id, [
      { serverUserId: serverUser.id, ratingKey: '' },
    ]);

    const matched = batch.get(`${serverUser.id}::`);
    expect(matched).toBeDefined();
    expect(matched!.map((row) => row.id)).toContain(insertedSession.id);
  });

  it('the grace-sweep confirm lookup finds a session created with an empty ratingKey', async () => {
    const { server, serverUser } = await setupServerAndUser();

    const input = buildCreationInput({ ratingKey: '', deviceId: 'device-1' }, server, serverUser);
    const { insertedSession } = await createSessionWithRulesAtomic(input);

    const found = await findActiveSessionByComposite({
      serverId: server.id,
      serverUserId: serverUser.id,
      deviceId: 'device-1',
      ratingKey: '',
    });

    expect(found).not.toBeNull();
    expect(found!.id).toBe(insertedSession.id);
  });

  it('a second create with the same identity would be deduped by the composite lookup', async () => {
    const { server, serverUser } = await setupServerAndUser();

    const first = await createSessionWithRulesAtomic(
      buildCreationInput({ ratingKey: '', deviceId: 'device-1' }, server, serverUser)
    );

    // The poller runs this batch lookup before deciding whether an incoming
    // session is new. If it finds the first row, tick 2 takes the update path
    // instead of inserting a duplicate.
    const batch = await batchFindActiveSessionsByComposite(server.id, [
      { serverUserId: serverUser.id, ratingKey: '' },
    ]);
    const matched = batch.get(`${serverUser.id}::`) ?? [];
    expect(matched.map((row) => row.id)).toContain(first.insertedSession.id);

    const activeRows = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.serverUserId, serverUser.id));
    expect(activeRows).toHaveLength(1);
  });
});
