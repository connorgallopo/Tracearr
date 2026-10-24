/**
 * Database client and connection pool
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

// Set by the connection budget service; survives recreatePool()
let poolMaxOverride: number | null = null;

function createPool(): pg.Pool {
  const p = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: poolMaxOverride ?? (Number(process.env.DATABASE_POOL_MAX) || 50),
    // A fresh backend loads every sessions chunk's indexes before it can plan, ~0.1-0.5 s
    // on a long history, so the steady-state pair stays open and only bursts above it close.
    min: 2,
    idleTimeoutMillis: 20000, // Close idle connections after 20s
    connectionTimeoutMillis: 5000, // Max wait to acquire a connection from the pool (not running query timeout)
    maxUses: 7500, // Max queries per connection before refresh (prevents memory leaks)
    allowExitOnIdle: false, // Keep pool alive during idle periods
    // Disable JIT — counterproductive for OLTP queries against TimescaleDB hypertables.
    // Custom plans only: under auto, the 6th run of a named statement builds a generic plan that
    // cannot exclude hypertable chunks at plan time (628 ms spike, 47 MB backend vs 2.4 MB).
    options: '-c jit=off -c plan_cache_mode=force_custom_plan',
  });

  // Log pool errors for debugging
  p.on('error', (err) => {
    console.error('[DB Pool Error]', err.message);
  });

  return p;
}

/**
 * Dedicated non-pooled client for sessions the pool can't hand out (advisory
 * locks, ALTER EXTENSION, migrations). Always carries an error listener: a
 * severed connection (postgres crash/restart) emits 'error' on an idle client,
 * and an unhandled 'error' event kills the process. A query in flight when the
 * connection drops rejects to its caller instead, listener or not.
 * `context` names the owner in the log line.
 */
export function createRawPgClient(context: string): pg.Client {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  client.on('error', (err) => {
    console.error(`[DB Client Error] (${context})`, err.message);
  });
  return client;
}

let pool = createPool();
// Exported as `let` so recreatePool() can reassign it. ESM live bindings ensure
// all modules importing `db` automatically see the new instance after reassignment.
export let db: NodePgDatabase<typeof schema> = drizzle(pool, { schema });

/** Transaction handle, or the plain client when there is no surrounding transaction. */
export type Executor = Parameters<Parameters<typeof db.transaction>[0]>[0] | typeof db;

/**
 * Resize the live pool. pg-pool reads options.max on every acquire;
 * connections above a lowered cap drain through idleTimeoutMillis.
 */
export function setPoolMax(max: number): void {
  poolMaxOverride = max;
  pool.options.max = max;
}

export function getPoolMax(): number {
  return pool.options.max ?? 0;
}

/**
 * Destroy the current pool and create a fresh one.
 * Used after ALTER EXTENSION updates so new connections pick up the updated extension,
 * and during restore to re-establish connections after DB replacement.
 *
 * Safe to call even if the pool was already closed via closeDatabase().
 */
export async function recreatePool(): Promise<void> {
  try {
    await pool.end();
  } catch {
    // Pool may already be closed (e.g. closeDatabase() was called first)
  }
  pool = createPool();
  db = drizzle(pool, { schema });
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export async function checkDatabaseConnection(): Promise<boolean> {
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    const message = err instanceof Error ? err.message : String(err);
    console.error('[DB Connect Error]', code ? `${code} ${message}` : message);
    return false;
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function runMigrations(migrationsFolder: string): Promise<void> {
  await migrate(db, { migrationsFolder });
}
