/**
 * GET /stats/engagement against a real database: tiers, per-account profiles and the summary
 * all come from one statement over daily_content_engagement.
 *
 * Run with: pnpm --filter @tracearr/server test:integration statsEngagement
 */

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import sensible from '@fastify/sensible';
import { sql } from 'drizzle-orm';
import type { AuthUser, EngagementStats } from '@tracearr/shared';
import {
  createTestServer,
  createTestUser,
  createTestServerUser,
  createTestSession,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { engagementRoutes } from '../../src/routes/stats/engagement.js';
import { permissionGuard } from '../../src/lib/scope.js';

const MIN_MS = 60_000;
const DAY_MS = 86_400_000;

describe('GET /stats/engagement', () => {
  it('classifies tiers, profiles and the summary from counted sessions', async () => {
    const server = await createTestServer({ type: 'plex' });
    const account = async (username: string) =>
      (
        await createTestServerUser({
          userId: (await createTestUser({ role: 'member' })).id,
          serverId: server.id,
          username,
        })
      ).id;
    const alice = await account('alice');
    const bob = await account('bob');
    const startedAt = new Date(Date.now() - 2 * DAY_MS);
    const watch = (
      serverUserId: string,
      ratingKey: string,
      mediaType: 'movie' | 'episode',
      totalMinutes: number,
      minutes: number
    ) =>
      createTestSession({
        serverId: server.id,
        serverUserId,
        ratingKey,
        mediaType,
        state: 'stopped',
        startedAt,
        stoppedAt: new Date(startedAt.getTime() + minutes * MIN_MS),
        durationMs: minutes * MIN_MS,
        progressMs: minutes * MIN_MS,
        totalDurationMs: totalMinutes * MIN_MS,
      });

    // Alice watches 90% of a movie, samples 25% of an episode, and opens it again for a minute
    await watch(alice, 'eng-movie', 'movie', 100, 90);
    await watch(alice, 'eng-episode', 'episode', 40, 10);
    await watch(alice, 'eng-episode', 'episode', 40, 1);
    // Bob watches the movie through twice
    await watch(bob, 'eng-movie', 'movie', 100, 100);
    await watch(bob, 'eng-movie', 'movie', 100, 100);
    await db.execute(
      sql`CALL refresh_continuous_aggregate('daily_content_engagement'::regclass, NULL, NULL)`
    );

    const owner: AuthUser = { userId: 'owner', username: 'owner', role: 'owner', serverIds: [] };
    const app = Fastify({ logger: false });
    await app.register(sensible);
    app.decorate('authenticate', async (request: { user: AuthUser }) => {
      request.user = owner;
    });
    app.decorate('requirePermission', permissionGuard(app));
    await app.register(engagementRoutes, { prefix: '/stats' });
    const res = await app.inject({ method: 'GET', url: '/stats/engagement?period=month' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json<EngagementStats>();
    expect([...body.engagementBreakdown].sort((a, b) => a.tier.localeCompare(b.tier))).toEqual([
      { tier: 'rewatched', count: 1, percentage: 33.3 },
      { tier: 'sampled', count: 1, percentage: 33.3 },
      { tier: 'watched', count: 1, percentage: 33.3 },
    ]);
    expect(body.userProfiles.map((p) => p.serverUserId)).toEqual([bob, alice]);
    expect(body.userProfiles[0]).toMatchObject({
      username: 'bob',
      contentStarted: 1,
      totalPlays: 2,
      totalWatchHours: 3.3,
      validSessionCount: 2,
      totalSessionCount: 2,
      rewatchedCount: 1,
      completionRate: 100,
      behaviorType: 'rewatcher',
      favoriteMediaType: 'movie',
    });
    expect(body.userProfiles[1]).toMatchObject({
      username: 'alice',
      contentStarted: 2,
      totalPlays: 1,
      totalWatchHours: 1.7,
      validSessionCount: 2,
      totalSessionCount: 3,
      watchedCount: 1,
      sampledCount: 1,
      abandonedCount: 0,
      completionRate: 50,
      behaviorType: 'casual',
    });
    expect(body.summary).toEqual({
      totalPlays: 3,
      totalValidSessions: 4,
      totalAllSessions: 5,
      sessionInflationPct: 66.7,
      avgCompletionRate: 105,
    });
  });
});
