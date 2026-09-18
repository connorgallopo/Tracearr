/**
 * Test database reset utilities
 *
 * Provides fast truncation between tests while preserving schema.
 * Only tables that actually hold rows are truncated; on an empty database
 * the reset is a single cheap SELECT instead of a full TRUNCATE.
 */

import { executeRawSql, closeTestPool } from './pool.js';

/**
 * Root tables owned by tests. The real truncate set is the recursive FK
 * closure of this list (any table that references one of these, directly or
 * transitively), derived from pg_constraint at runtime so new referencing
 * tables are covered without touching this file.
 */
const ROOT_TABLES = [
  'automation_runs',
  'notification_preferences',
  'mobile_sessions',
  'mobile_tokens',
  'sessions',
  'library_items',
  'media',
  'automation_templates',
  'automations',
  'server_users',
  'servers',
  'users',
  'settings',
  'destinations',
  'newsletters',
  'email_suppressions',
];

let cachedTables: string[] | null = null;
let cachedDirtyCheckSql: string | null = null;

async function loadTruncateTargets(): Promise<string[] | null> {
  if (cachedTables) return cachedTables;

  const rootList = ROOT_TABLES.map((t) => `'${t}'`).join(', ');
  const result = await executeRawSql(`
    WITH RECURSIVE fk_closure(oid) AS (
      SELECT c.oid
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname IN (${rootList})
      UNION
      SELECT con.conrelid
      FROM pg_constraint con
      JOIN fk_closure f ON con.confrelid = f.oid
      WHERE con.contype = 'f'
    )
    SELECT c.relname
    FROM fk_closure f
    JOIN pg_class c ON c.oid = f.oid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
    ORDER BY c.relname
  `);

  const found = result.rows.map((row) => row.relname as string);
  if (ROOT_TABLES.some((t) => !found.includes(t))) {
    console.warn('[Test Reset] Tables do not exist yet, skipping truncation');
    return null;
  }

  cachedTables = found;
  cachedDirtyCheckSql = found
    .map((t) => `SELECT '${t}'::text AS tbl WHERE EXISTS (SELECT 1 FROM "${t}")`)
    .join(' UNION ALL ');
  return cachedTables;
}

/**
 * Reset the test database between tests
 *
 * Truncates all non-empty tables in the FK closure but preserves schema.
 * Call this in beforeEach() to ensure test isolation.
 */
export async function resetTestDb(): Promise<void> {
  const tables = await loadTruncateTargets();
  if (!tables || !cachedDirtyCheckSql) return;

  const dirty = await executeRawSql(cachedDirtyCheckSql);
  if (dirty.rows.length === 0) return;

  const dirtyList = dirty.rows.map((row) => `"${row.tbl as string}"`).join(', ');
  await executeRawSql(`TRUNCATE TABLE ${dirtyList} RESTART IDENTITY CASCADE`);
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
