/**
 * Vitest Integration Test Setup
 *
 * This setup file is used for integration tests that require a real database.
 * It handles database initialization, migrations, TimescaleDB setup, cleanup,
 * and provides proper test isolation.
 *
 * Uses the same database initialization as production server (index.ts):
 * 1. Run Drizzle migrations
 * 2. Initialize TimescaleDB (hypertables, compression, aggregates)
 *
 * Usage: vitest.integration.config.ts references this file.
 *
 * Requirements:
 * - Test database running: docker compose -f docker/docker-compose.test.yml up -d
 * - Migrations and TimescaleDB setup run automatically on first test run
 */

import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { installMatchers } from '@tracearr/test-utils/matchers';
import { resetAllFactoryCounters } from '@tracearr/test-utils/factories';
import { resetAllMocks } from '@tracearr/test-utils/mocks';
import { setupIntegrationTests, resetDatabaseBeforeEach } from '@tracearr/test-utils/vitest.setup';

// Set test environment variables BEFORE any database imports
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-must-be-32-chars-min';
process.env.ENCRYPTION_KEY = 'test-encryption-key-32-chars!!!';
// Use port 5433 for test database (docker-compose.test.yml) to avoid conflicts with dev
process.env.DATABASE_URL =
  process.env.TEST_DATABASE_URL || 'postgresql://test:test@localhost:5433/tracearr_test';
// Use port 6380 for test Redis to avoid conflicts with dev
process.env.REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6380';

// Install custom vitest matchers from test-utils
installMatchers();

// Silence console.log in tests unless DEBUG=true
if (!process.env.DEBUG) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  vi.spyOn(console, 'log').mockImplementation(() => {});
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  vi.spyOn(console, 'info').mockImplementation(() => {});
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}

// Database cleanup function
let cleanup: (() => Promise<void>) | null = null;

// Get the migrations folder path (same as server index.ts uses)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const migrationsFolder = resolve(__dirname, '../db/migrations');

beforeAll(async () => {
  process.env.TEST_INITIALIZED = 'true';

  // Set up database connection
  cleanup = await setupIntegrationTests();

  // Run migrations (same as server startup)
  const { runMigrations } = await import('../db/client.js');
  try {
    await runMigrations(migrationsFolder);
  } catch (error) {
    // Migrations may have already been applied - that's OK
    if (error instanceof Error && !error.message.includes('already exists')) {
      console.error('[Test Setup] Migration error:', error.message);
      throw error;
    }
  }

  // Initialize TimescaleDB (same as server startup)
  // This sets up hypertables, compression, continuous aggregates, and indexes
  const { initTimescaleDB } = await import('../db/timescale.js');
  try {
    await initTimescaleDB();
  } catch (error) {
    // TimescaleDB is optional - tests can still run without it
    if (process.env.DEBUG) {
      console.warn('[Test Setup] TimescaleDB init warning:', error);
    }
  }
});

// Reset database and factories before each test for isolation
beforeEach(async () => {
  resetAllFactoryCounters();
  resetAllMocks();

  // Reset database to clean state
  await resetDatabaseBeforeEach();
});

afterAll(async () => {
  delete process.env.TEST_INITIALIZED;

  // Close database connection pool
  if (cleanup) {
    await cleanup();
  }
});
