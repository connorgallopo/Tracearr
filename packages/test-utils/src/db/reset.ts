/**
 * Test database reset utilities
 *
 * Provides fast truncation between test files while preserving schema.
 * Uses TRUNCATE CASCADE for efficient cleanup.
 */

import { executeRawSql, closeTestPool } from './pool.js';

/**
 * Tables to truncate in dependency order (leaf tables first)
 *
 * Order matters for CASCADE to work properly:
 * 1. violations (depends on rules, server_users, sessions)
 * 2. notification_preferences (depends on mobile_sessions)
 * 3. notification_channel_routing (standalone)
 * 4. mobile_sessions (depends on nothing)
 * 5. mobile_tokens (depends on users)
 * 6. sessions (depends on servers, server_users)
 * 7. rules (depends on server_users)
 * 8. server_users (depends on users, servers)
 * 9. servers (standalone)
 * 10. users (standalone)
 * 11. settings (standalone, single row)
 */
const TABLES_TO_TRUNCATE = [
  'violations',
  'notification_preferences',
  'notification_channel_routing',
  'mobile_sessions',
  'mobile_tokens',
  'sessions',
  'rules',
  'server_users',
  'servers',
  'users',
  // Settings is a single-row config table, reset to defaults instead
];

/**
 * Reset the test database between test files
 *
 * Truncates all tables but preserves schema.
 * Fast and efficient for integration tests.
 *
 * Call this in afterEach() to ensure test isolation.
 */
export async function resetTestDb(): Promise<void> {
  try {
    // Use a single TRUNCATE command with CASCADE for efficiency
    await executeRawSql(`TRUNCATE TABLE ${TABLES_TO_TRUNCATE.join(', ')} RESTART IDENTITY CASCADE`);

    // Reset settings to defaults (it's a single-row table)
    await executeRawSql(`
      DELETE FROM settings WHERE id = 1;
      INSERT INTO settings (id) VALUES (1);
    `);
  } catch (error) {
    // Table might not exist yet if migrations haven't run
    if (error instanceof Error && error.message.includes('does not exist')) {
      console.warn('[Test Reset] Tables do not exist yet, skipping truncation');
      return;
    }
    throw error;
  }
}

/**
 * Full teardown of test database resources
 *
 * Call this in global afterAll() to release connections.
 */
export async function teardownTestDb(): Promise<void> {
  await closeTestPool();
}

/**
 * Clean up specific tables (useful for targeted cleanup)
 */
export async function truncateTables(tables: string[]): Promise<void> {
  if (tables.length === 0) return;

  await executeRawSql(`TRUNCATE TABLE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}
