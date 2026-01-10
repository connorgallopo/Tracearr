/**
 * Database client and connection pool
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DATABASE_POOL_MAX) || 50,
  idleTimeoutMillis: 20000, // Close idle connections after 20s
  connectionTimeoutMillis: 10000, // Connection timeout (increased for complex queries)
  maxUses: 7500, // Max queries per connection before refresh (prevents memory leaks)
  allowExitOnIdle: false, // Keep pool alive during idle periods
});

// Log pool errors for debugging
pool.on('error', (err) => {
  console.error('[DB Pool Error]', err.message);
});

export const db = drizzle(pool, { schema });

export async function closeDatabase(): Promise<void> {
  await pool.end();
}

export async function checkDatabaseConnection(): Promise<boolean> {
  let client: pg.PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query('SELECT 1');
    return true;
  } catch (error) {
    console.error('Database connection check failed:', error);
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
