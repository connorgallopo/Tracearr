/**
 * Test database setup utilities
 *
 * Sets up the test database with schema and TimescaleDB extensions.
 * Designed for integration tests that need a real database.
 */

import { getTestPool, executeRawSql } from './pool.js';

let isSetup = false;

/**
 * Set up the test database
 *
 * - Creates TimescaleDB extension if not exists
 * - Runs migrations or pushes schema
 * - Should be called once in global setup (beforeAll)
 */
export async function setupTestDb(): Promise<void> {
  if (isSetup) return;

  const pool = getTestPool();

  // Verify connection
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
  } catch (error) {
    throw new Error(
      `Failed to connect to test database. Ensure TimescaleDB is running. Error: ${error instanceof Error ? error.message : error}`
    );
  }

  // Enable TimescaleDB extension (if available)
  try {
    await executeRawSql('CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE');
  } catch {
    // TimescaleDB may not be available in all test environments
    console.warn('[Test Setup] TimescaleDB extension not available, continuing without it');
  }

  isSetup = true;
}

/**
 * Check if test database is ready
 */
export async function isTestDbReady(): Promise<boolean> {
  try {
    const pool = getTestPool();
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch {
    return false;
  }
}

/**
 * Wait for test database to be ready (with retries)
 *
 * Useful in CI where database container may still be starting.
 */
export async function waitForTestDb(maxRetries = 30, retryDelayMs = 1000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    if (await isTestDbReady()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
  }
  throw new Error(`Test database not ready after ${maxRetries} retries`);
}
