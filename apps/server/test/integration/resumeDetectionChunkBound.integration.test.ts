/**
 * createSessionWithRulesAtomic's STEP 2 resume-detection query (sessionLifecycle.ts)
 * used to filter only on stopped_at, so every chunk of the started_at-partitioned
 * sessions hypertable got probed on every session create. Adding
 * gte(started_at, chunkBound) reduces chunk scanning, but the bound must be wide
 * enough to cover a session whose wall-clock duration exceeds the 24h resume
 * window (e.g. a live TV session kept alive for days by polling), where
 * startedAt is far older than stoppedAt. RESUME_CHUNK_BOUND_MS covers the
 * resume window plus the max in-scope session duration (24h + 7d = 8 days).
 * These tests pin: resumes still link within that 8-day bound, and a session
 * that ran longer than the max in-scope duration loses resume chaining, an
 * accepted tradeoff.
 *
 * Run with: pnpm --filter @tracearr/server test:integration -- resumeDetectionChunkBound
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { DEFAULT_STREAM_DETAILS, type ServerType } from '@tracearr/shared';
import {
  createTestUser,
  createTestServer,
  createTestServerUser,
  createStoppedSession,
} from '@tracearr/test-utils/factories';
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

async function setupServerAndUser() {
  const server = await createTestServer({ type: 'plex' });
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

describe('resume detection respects the TimescaleDB chunk bound without losing real resumes', () => {
  it('links a new session to a same-content session stopped an hour ago, started an hour ago', async () => {
    const { server, serverUser } = await setupServerAndUser();
    const ratingKey = `rk-${randomUUID()}`;

    const previous = await createStoppedSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey,
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      stoppedAt: new Date(Date.now() - 30 * 60 * 1000),
      progressMs: 1_000_000,
      watched: false,
    });

    const input = buildCreationInput({ ratingKey, progressMs: 1_200_000 }, server, serverUser);

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    expect(insertedSession.referenceId).toBe(previous.id);
  });

  it('links a resume even when the previous session started 6.9 days ago (inside the 7-day chunk bound) and stopped 1h ago', async () => {
    const { server, serverUser } = await setupServerAndUser();
    const ratingKey = `rk-${randomUUID()}`;

    const previous = await createStoppedSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey,
      startedAt: new Date(Date.now() - 6.9 * 24 * 60 * 60 * 1000),
      stoppedAt: new Date(Date.now() - 60 * 60 * 1000),
      progressMs: 500_000,
      watched: false,
    });

    const input = buildCreationInput({ ratingKey, progressMs: 900_000 }, server, serverUser);

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    expect(insertedSession.referenceId).toBe(previous.id);
  });

  it('links a resume when the previous session started 8 days minus a margin ago (long-running live session) and stopped 30 minutes ago', async () => {
    const { server, serverUser } = await setupServerAndUser();
    const ratingKey = `rk-${randomUUID()}`;

    const previous = await createStoppedSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey,
      startedAt: new Date(Date.now() - (8 * 24 * 60 * 60 * 1000 - 60 * 60 * 1000)),
      stoppedAt: new Date(Date.now() - 30 * 60 * 1000),
      progressMs: 500_000,
      watched: false,
    });

    const input = buildCreationInput({ ratingKey, progressMs: 900_000 }, server, serverUser);

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    expect(insertedSession.referenceId).toBe(previous.id);
  });

  it('does not link when the previous session started 9 days ago (beyond the resume chunk bound), even though it stopped 30 minutes ago', async () => {
    const { server, serverUser } = await setupServerAndUser();
    const ratingKey = `rk-${randomUUID()}`;

    await createStoppedSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey,
      startedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
      stoppedAt: new Date(Date.now() - 30 * 60 * 1000),
      progressMs: 500_000,
      watched: false,
    });

    const input = buildCreationInput({ ratingKey, progressMs: 900_000 }, server, serverUser);

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    expect(insertedSession.referenceId).toBeNull();
  });

  it('does not link when the previous session stopped more than 24h ago', async () => {
    const { server, serverUser } = await setupServerAndUser();
    const ratingKey = `rk-${randomUUID()}`;

    await createStoppedSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey,
      startedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
      stoppedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      progressMs: 500_000,
      watched: false,
    });

    const input = buildCreationInput({ ratingKey, progressMs: 900_000 }, server, serverUser);

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    expect(insertedSession.referenceId).toBeNull();
  });

  it('does not link when the new session progress regressed below the previous session', async () => {
    const { server, serverUser } = await setupServerAndUser();
    const ratingKey = `rk-${randomUUID()}`;

    await createStoppedSession({
      serverId: server.id,
      serverUserId: serverUser.id,
      ratingKey,
      startedAt: new Date(Date.now() - 60 * 60 * 1000),
      stoppedAt: new Date(Date.now() - 30 * 60 * 1000),
      progressMs: 1_000_000,
      watched: false,
    });

    const input = buildCreationInput({ ratingKey, progressMs: 100_000 }, server, serverUser);

    const { insertedSession } = await createSessionWithRulesAtomic(input);

    expect(insertedSession.referenceId).toBeNull();
  });
});
