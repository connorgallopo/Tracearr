#!/usr/bin/env node
/**
 * Runs before the e2e server process even starts (chained into the
 * webServer command in playwright.config.ts): Playwright starts webServer
 * BEFORE globalSetup.ts runs (webServer is a "plugin", and plugin setup
 * tasks precede the globalSetups array), so the app's own boot-time
 * migration runner would otherwise crash-loop against a database that
 * doesn't exist yet on a fresh checkout. Plain JS, not TypeScript, so it
 * needs no loader to run via a bare `node` invocation from the shell
 * command string - constants here intentionally mirror seed/env.ts (kept in
 * sync by hand; there are only four of them, SHOWCASE included).
 */
import pg from 'pg';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REQUIRED_DB_NAME = (process.env.SHOWCASE ?? '') !== '' ? 'tracearr_showcase' : 'tracearr_e2e';
const databaseUrl =
  process.env.E2E_DATABASE_URL ?? `postgresql://test:test@localhost:5433/${REQUIRED_DB_NAME}`;

function fail(message) {
  console.error(`[prepareDatabase] ${message}`);
  process.exit(1);
}

const actualName = databaseUrl.slice(databaseUrl.lastIndexOf('/') + 1).split('?')[0];
if (actualName !== REQUIRED_DB_NAME) {
  fail(`Refusing to prepare a database that isn't "${REQUIRED_DB_NAME}" (got "${actualName}")`);
}

const maintenanceUrl = databaseUrl.replace(/\/[^/]+$/, '/postgres');
const client = new pg.Client({ connectionString: maintenanceUrl });
await client.connect();
try {
  const { rows } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [
    REQUIRED_DB_NAME,
  ]);
  if (rows.length === 0) {
    await client.query(`CREATE DATABASE "${REQUIRED_DB_NAME}"`);
    console.log(`[prepareDatabase] created database "${REQUIRED_DB_NAME}"`);
  }
} finally {
  await client.end();
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const result = spawnSync('pnpm', ['--filter', '@tracearr/server', 'db:migrate'], {
  cwd: repoRoot,
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: 'inherit',
});
if (result.status !== 0) {
  fail(`migration failed (exit ${result.status})`);
}
