import pg from 'pg';
import { maintenanceDatabaseUrl, requiredDatabaseName } from './env';

/** Idempotent: creates the run's database on the test container if it doesn't
 * already exist yet (mirrors `docker exec ... psql -c 'CREATE DATABASE ...'`,
 * done here too so a fresh CI checkout doesn't need a manual step). */
export async function ensureDatabaseExists(): Promise<void> {
  const name = requiredDatabaseName();
  const client = new pg.Client({ connectionString: maintenanceDatabaseUrl() });
  await client.connect();
  try {
    const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (rows.length === 0) {
      // Database names can't be parameterized; the name is one of two fixed
      // literals in env.ts, never user input.
      await client.query(`CREATE DATABASE "${name}"`);
    }
  } finally {
    await client.end();
  }
}
