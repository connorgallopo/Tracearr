/**
 * E2E database/redis targets. Defaults point at the isolated 5433 test
 * container (docker/docker-compose.test.yml), never the live dev stack on
 * 5432/6379 - overridable for CI via E2E_DATABASE_URL / E2E_REDIS_URL.
 *
 * SHOWCASE=1 moves every default onto its own database and redis prefix, so
 * the screenshot run (showcase/seed.ts) and the normal suite never share
 * state; the guard below accepts exactly the name the flag selects.
 */

export const E2E_DB_NAME = 'tracearr_e2e';
export const SHOWCASE_DB_NAME = 'tracearr_showcase';

export function isShowcase(): boolean {
  return (process.env.SHOWCASE ?? '') !== '';
}

export function requiredDatabaseName(): string {
  return isShowcase() ? SHOWCASE_DB_NAME : E2E_DB_NAME;
}

export function e2eDatabaseUrl(): string {
  return (
    process.env.E2E_DATABASE_URL ??
    `postgresql://test:test@localhost:5433/${requiredDatabaseName()}`
  );
}

export function e2eRedisUrl(): string {
  return process.env.E2E_REDIS_URL ?? 'redis://localhost:6380';
}

export function e2eRedisPrefix(): string {
  return process.env.E2E_REDIS_PREFIX ?? (isShowcase() ? 'trr_showcase_' : 'trr_e2e_');
}

/**
 * Same host/credentials as the target URL, pointed at the "postgres" system
 * database - the only one guaranteed to exist regardless of the container's
 * POSTGRES_DB (tracearr_test locally, tracearr_e2e in CI).
 */
export function maintenanceDatabaseUrl(): string {
  return e2eDatabaseUrl().replace(/\/[^/]+$/, '/postgres');
}

export function databaseNameFromUrl(url: string): string {
  return url.slice(url.lastIndexOf('/') + 1).split('?')[0] ?? '';
}
