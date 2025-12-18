/**
 * Test database seeding utilities
 *
 * Pre-built scenarios for common test setups.
 * Use these to quickly set up test data without repetitive boilerplate.
 */

import { executeRawSql } from './pool.js';

export interface SeedResult {
  userId: string;
  serverId: string;
  serverUserId: string;
  ruleId?: string;
  sessionId?: string;
  violationId?: string;
}

/**
 * Seed a basic owner user with a Plex server
 *
 * Creates:
 * - 1 owner user
 * - 1 Plex server
 * - 1 server_user linking them
 * - Default settings row
 */
export async function seedBasicOwner(): Promise<SeedResult> {
  // Create owner user
  const userResult = await executeRawSql(`
    INSERT INTO users (username, name, role, aggregate_trust_score)
    VALUES ('testowner', 'Test Owner', 'owner', 100)
    RETURNING id
  `);
  const userId = userResult.rows[0].id as string;

  // Create Plex server
  const serverResult = await executeRawSql(`
    INSERT INTO servers (name, type, url, token)
    VALUES ('Test Plex Server', 'plex', 'http://localhost:32400', 'test-token-encrypted')
    RETURNING id
  `);
  const serverId = serverResult.rows[0].id as string;

  // Create server_user
  const serverUserResult = await executeRawSql(`
    INSERT INTO server_users (user_id, server_id, external_id, username, is_server_admin, trust_score)
    VALUES ('${userId}', '${serverId}', 'plex-user-1', 'testowner', true, 100)
    RETURNING id
  `);
  const serverUserId = serverUserResult.rows[0].id as string;

  // Ensure settings row exists
  await executeRawSql(`
    INSERT INTO settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);

  return { userId, serverId, serverUserId };
}

/**
 * Seed multiple users with a shared server
 *
 * Creates:
 * - 1 owner user
 * - N member users
 * - 1 Plex server
 * - N+1 server_users
 */
export async function seedMultipleUsers(memberCount: number = 3): Promise<{
  owner: SeedResult;
  members: SeedResult[];
}> {
  const owner = await seedBasicOwner();
  const members: SeedResult[] = [];

  for (let i = 0; i < memberCount; i++) {
    // Create member user
    const userResult = await executeRawSql(`
      INSERT INTO users (username, name, role, aggregate_trust_score)
      VALUES ('member${i + 1}', 'Member ${i + 1}', 'member', 100)
      RETURNING id
    `);
    const userId = userResult.rows[0].id as string;

    // Create server_user for member
    const serverUserResult = await executeRawSql(`
      INSERT INTO server_users (user_id, server_id, external_id, username, is_server_admin, trust_score)
      VALUES ('${userId}', '${owner.serverId}', 'plex-user-${i + 2}', 'member${i + 1}', false, 100)
      RETURNING id
    `);
    const serverUserId = serverUserResult.rows[0].id as string;

    members.push({
      userId,
      serverId: owner.serverId,
      serverUserId,
    });
  }

  return { owner, members };
}

/**
 * Seed a user with active sessions
 *
 * Creates a user with N active (playing) sessions.
 * Useful for testing concurrent streams detection.
 */
export async function seedUserWithSessions(
  sessionCount: number = 2
): Promise<SeedResult & { sessionIds: string[] }> {
  const base = await seedBasicOwner();
  const sessionIds: string[] = [];

  for (let i = 0; i < sessionCount; i++) {
    const sessionResult = await executeRawSql(`
      INSERT INTO sessions (
        server_id, server_user_id, session_key, state, media_type,
        media_title, ip_address, geo_city, geo_country, geo_lat, geo_lon,
        device_id, platform
      ) VALUES (
        '${base.serverId}', '${base.serverUserId}', 'session-${i + 1}', 'playing', 'movie',
        'Test Movie ${i + 1}', '192.168.1.${100 + i}', 'Test City', 'US', 40.7128, -74.0060,
        'device-${i + 1}', 'Plex Web'
      )
      RETURNING id
    `);
    sessionIds.push(sessionResult.rows[0].id as string);
  }

  return { ...base, sessionIds };
}

/**
 * Seed a complete rule evaluation scenario
 *
 * Creates:
 * - Owner user with server
 * - Active rule (concurrent_streams with max 2)
 * - 3 active sessions (triggers violation)
 */
export async function seedViolationScenario(): Promise<
  SeedResult & {
    ruleId: string;
    sessionIds: string[];
    violationId?: string;
  }
> {
  const base = await seedUserWithSessions(3);

  // Create concurrent streams rule
  const ruleResult = await executeRawSql(`
    INSERT INTO rules (name, type, params, is_active)
    VALUES (
      'Max 2 Streams',
      'concurrent_streams',
      '{"max_streams": 2}'::jsonb,
      true
    )
    RETURNING id
  `);
  const ruleId = ruleResult.rows[0].id as string;

  return {
    ...base,
    ruleId,
  };
}

/**
 * Seed mobile pairing scenario
 *
 * Creates:
 * - Owner user
 * - Valid mobile pairing token
 */
export async function seedMobilePairing(): Promise<SeedResult & { tokenHash: string }> {
  const base = await seedBasicOwner();

  // Enable mobile in settings
  await executeRawSql(`
    UPDATE settings SET mobile_enabled = true WHERE id = 1
  `);

  // Create a pairing token (hash of 'test-mobile-token')
  // In real usage, this would be SHA-256 hash
  const tokenHash = 'abcd1234567890abcdef1234567890abcdef1234567890abcdef1234567890ab';
  await executeRawSql(`
    INSERT INTO mobile_tokens (token_hash, expires_at, created_by)
    VALUES (
      '${tokenHash}',
      NOW() + INTERVAL '15 minutes',
      '${base.userId}'
    )
  `);

  return { ...base, tokenHash };
}
