/**
 * The poller stamps canonical media identity onto sessions at insert time.
 *
 * batchGetLibraryItemIdentity reads library_items (joined to media for the
 * show identity) so the poller can attach mediaId/provider ids to a session
 * in one query per poll cycle. createSessionWithRulesAtomic then persists
 * those fields onto the sessions row.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- pollerIdentity
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { DEFAULT_STREAM_DETAILS, type ServerType } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createTestLibraryItem,
} from '@tracearr/test-utils/factories';
import { db } from '../../src/db/client.js';
import { resolveMediaForItem } from '../../src/services/library/mediaResolutionService.js';
import { batchGetLibraryItemIdentity } from '../../src/jobs/poller/database.js';
import { createSessionWithRulesAtomic } from '../../src/jobs/poller/sessionLifecycle.js';
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

describe('poller stamps media identity onto sessions', () => {
  it('stamps identity from library_items at session insert', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: '2733',
      imdbId: 'tt0322259',
      tmdbId: 584,
      mediaId,
    });
    const identityMap = await batchGetLibraryItemIdentity(server.id, ['2733']);
    expect(identityMap.get('2733')).toMatchObject({ mediaId, imdbId: 'tt0322259', tmdbId: 584 });
  });

  it('persists the stamped identity onto the sessions row', async () => {
    const server = await createTestServer({ type: 'plex' });
    const user = await createTestUser();
    const serverUser = await createTestServerUser({ userId: user.id, serverId: server.id });
    const mediaId = await resolveMediaForItem({
      mediaType: 'movie',
      imdbId: 'tt0322259',
      title: '2 Fast 2 Furious',
      year: 2003,
      serverId: server.id,
      ratingKey: '2733',
    });
    await createTestLibraryItem({
      serverId: server.id,
      ratingKey: '2733',
      imdbId: 'tt0322259',
      tmdbId: 584,
      mediaId,
    });

    const identityMap = await batchGetLibraryItemIdentity(server.id, ['2733']);
    const input = buildCreationInput({ ratingKey: '2733' }, server, serverUser);
    input.processed.identity = identityMap.get('2733') ?? null;

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    const result = await db.execute<{
      media_id: string | null;
      imdb_id: string | null;
      tmdb_id: number | null;
    }>(sql`SELECT media_id, imdb_id, tmdb_id FROM sessions WHERE id = ${insertedSession.id}`);

    expect(result.rows[0]?.media_id).toBe(mediaId);
    expect(result.rows[0]?.imdb_id).toBe('tt0322259');
    expect(result.rows[0]?.tmdb_id).toBe(584);
  });
});
