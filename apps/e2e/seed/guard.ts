import type { Client } from 'pg';
import { requiredDatabaseName } from './env';

/**
 * Hard, fail-closed safety check: refuses to run any seed/reset statement
 * unless the connection is actually talking to the database the run selected
 * (tracearr_e2e, or tracearr_showcase under SHOWCASE=1). Protecting the live
 * dev database outranks convenience - this must throw, never warn.
 */
export async function assertSafeDatabase(client: Client): Promise<void> {
  const { rows } = await client.query<{ name: string }>('SELECT current_database() AS name');
  const name = rows[0]?.name;
  const required = requiredDatabaseName();
  if (name !== required) {
    throw new Error(
      `Refusing to seed/reset database "${name}" - this run only ever touches ` +
        `"${required}". Set E2E_DATABASE_URL to point at the isolated test database.`
    );
  }
}
