import pg from 'pg';
import { e2eDatabaseUrl, isShowcase } from './env';
import { assertSafeDatabase } from './guard';
import { ensureDatabaseExists } from './ensureDatabase';
import { runMigrations } from './migrate';
import { seedCore } from './seedCore';

/**
 * Playwright globalSetup: runs once, before any project. Bootstraps the
 * isolated e2e database end to end (create if missing, migrate, seed the
 * bulk fixture data) so tracearr_e2e is ready before the webServer or the
 * auth setup project ever touches it. See apps/e2e/README.md for the guard
 * design and the two-phase seed (this step, then media-browse.setup.ts).
 *
 * The showcase run seeds its own database from the capture spec, so the core
 * fixtures stay out of it.
 */
export default async function globalSetup(): Promise<void> {
  await ensureDatabaseExists();

  const databaseUrl = e2eDatabaseUrl();
  runMigrations(databaseUrl);

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await assertSafeDatabase(client);
    if (!isShowcase()) await seedCore(client);
  } finally {
    await client.end();
  }
}
