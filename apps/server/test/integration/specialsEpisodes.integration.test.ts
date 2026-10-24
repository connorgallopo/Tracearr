/**
 * Season 0 (Specials) episodes must persist with season_number = 0, not NULL.
 *
 * createSessionWithRulesAtomic used to write `processed.seasonNumber || null`,
 * which coerces a real value of 0 into NULL (0 is falsy). This silently
 * dropped every Specials episode's season/episode numbers at the single
 * canonical sessions INSERT, and the same pattern existed in every place
 * that builds a Session/ActiveSession from a ProcessedSession. Confirms the
 * persist path preserves 0, keeps genuinely unknown values as NULL, and
 * that a movie (no episode metadata) never gets a season/episode number.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- specialsEpisodes
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import type { Redis } from 'ioredis';
import { DEFAULT_STREAM_DETAILS } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
} from '@tracearr/test-utils/factories';
import { createMockRedis } from '@tracearr/test-utils/mocks';
import { db } from '../../src/db/client.js';
import { sql } from 'drizzle-orm';
import { createSessionWithRulesAtomic } from '../../src/jobs/poller/sessionLifecycle.js';
import type { SessionCreationInput } from '../../src/jobs/poller/types.js';
import { sessionRoutes } from '../../src/routes/sessions/index.js';
import { permissionGuard } from '../../src/lib/scope.js';

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

function ownerAuth(userId: string) {
  return { userId, username: 'owner', role: 'owner' as const, serverIds: [] as string[] };
}

async function buildApp() {
  const app = Fastify({ logger: false });
  await app.register(sensible);
  app.decorate('redis', createMockRedis() as unknown as Redis);
  app.decorate('authenticate', async (request: any) => {
    request.user = ownerAuth('owner');
  });
  app.decorate('requirePermission', permissionGuard(app));
  app.decorate('requireOwner', async (request: any, reply: any) => {
    await app.authenticate(request, reply);
    if (request.user.role !== 'owner') return reply.forbidden('Owner access required');
  });
  await app.register(sessionRoutes as any);
  return app;
}

async function setupServerAndUser() {
  const server = await createTestServer({ type: 'plex' });
  const user = await createTestUser();
  const serverUser = await createTestServerUser({ serverId: server.id, userId: user.id });
  return { server, user, serverUser };
}

/** Build a minimal SessionCreationInput, overriding only the episode-relevant fields. */
function buildCreationInput(
  overrides: Partial<SessionCreationInput['processed']>,
  server: { id: string; name: string; type: 'plex' | 'jellyfin' | 'emby' },
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

describe('Specials (Season 0) episodes persist their season/episode numbers', () => {
  it('persists season_number = 0 and the episode number for a Season 0 episode', async () => {
    const { server, serverUser } = await setupServerAndUser();

    const input = buildCreationInput(
      {
        mediaType: 'episode',
        grandparentTitle: 'Behind the Scenes Show',
        mediaTitle: 'Making Of',
        seasonNumber: 0,
        episodeNumber: 1,
      },
      server,
      serverUser
    );

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    const result = await db.execute<{
      season_number: number | null;
      episode_number: number | null;
    }>(sql`SELECT season_number, episode_number FROM sessions WHERE id = ${insertedSession.id}`);

    expect(result.rows[0]?.season_number).toBe(0);
    expect(result.rows[0]?.episode_number).toBe(1);
  });

  it('persists NULL season/episode for a movie (no episode metadata)', async () => {
    const { server, serverUser } = await setupServerAndUser();

    const input = buildCreationInput(
      {
        mediaType: 'movie',
        mediaTitle: 'Test Movie',
        seasonNumber: null,
        episodeNumber: null,
      },
      server,
      serverUser
    );

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    const result = await db.execute<{
      season_number: number | null;
      episode_number: number | null;
    }>(sql`SELECT season_number, episode_number FROM sessions WHERE id = ${insertedSession.id}`);

    expect(result.rows[0]?.season_number).toBeNull();
    expect(result.rows[0]?.episode_number).toBeNull();
  });

  it('persists NULL season for a season-unknown episode while keeping the episode number', async () => {
    const { server, serverUser } = await setupServerAndUser();

    const input = buildCreationInput(
      {
        mediaType: 'episode',
        grandparentTitle: 'Mystery Show',
        mediaTitle: 'Unknown Season Episode',
        seasonNumber: null,
        episodeNumber: 4,
      },
      server,
      serverUser
    );

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    const result = await db.execute<{
      season_number: number | null;
      episode_number: number | null;
    }>(sql`SELECT season_number, episode_number FROM sessions WHERE id = ${insertedSession.id}`);

    expect(result.rows[0]?.season_number).toBeNull();
    expect(result.rows[0]?.episode_number).toBe(4);
  });

  it('returns the Season 0 episode from the history endpoint with season_number 0 intact', async () => {
    const { server, serverUser } = await setupServerAndUser();

    const input = buildCreationInput(
      {
        mediaType: 'episode',
        grandparentTitle: 'History Show',
        mediaTitle: 'Special Feature',
        seasonNumber: 0,
        episodeNumber: 2,
      },
      server,
      serverUser
    );

    const { insertedSession } = await createSessionWithRulesAtomic(input);
    // History only returns sessions with recorded duration - stop the session first.
    await db.execute(
      sql`UPDATE sessions SET stopped_at = NOW(), duration_ms = 300000 WHERE id = ${insertedSession.id}`
    );

    const app = await buildApp();
    const response = await app.inject({ method: 'GET', url: '/history' });
    await app.close();

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      data: Array<{ id: string; seasonNumber: number | null; episodeNumber: number | null }>;
    };
    const entry = body.data.find((d) => d.id === insertedSession.id);
    expect(entry).toBeDefined();
    expect(entry?.seasonNumber).toBe(0);
    expect(entry?.episodeNumber).toBe(2);
  });

  it('is not excluded from the engagement aggregate by season_number IS NOT NULL filters', async () => {
    const { server, serverUser } = await setupServerAndUser();

    const input = buildCreationInput(
      {
        mediaType: 'episode',
        grandparentTitle: 'Engagement Show',
        mediaTitle: 'Special Feature',
        seasonNumber: 0,
        episodeNumber: 5,
        totalDurationMs: 600_000,
      },
      server,
      serverUser
    );

    const { insertedSession } = await createSessionWithRulesAtomic(input);
    await db.execute(
      sql`UPDATE sessions SET stopped_at = NOW(), duration_ms = 300000, watched = true WHERE id = ${insertedSession.id}`
    );
    await db.execute(
      sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
    );

    const result = await db.execute<{ season_number: number | null }>(
      sql`
        SELECT season_number FROM content_engagement_summary
        WHERE server_user_id = ${serverUser.id}
          AND rating_key = ${input.processed.ratingKey}
          AND season_number IS NOT NULL
      `
    );

    expect(result.rows).toHaveLength(1);
    expect((result.rows[0] as { season_number: number | null }).season_number).toBe(0);
  });
});
