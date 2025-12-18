/**
 * User factory for test data generation
 *
 * Creates user entities with sensible defaults that can be overridden.
 */

import { executeRawSql } from '../db/pool.js';

export interface UserData {
  id?: string;
  username?: string;
  name?: string | null;
  email?: string | null;
  thumbnail?: string | null;
  passwordHash?: string | null;
  plexAccountId?: string | null;
  role?: 'owner' | 'admin' | 'viewer' | 'member' | 'disabled' | 'pending';
  aggregateTrustScore?: number;
  totalViolations?: number;
}

export interface CreatedUser extends Required<
  Omit<UserData, 'passwordHash' | 'plexAccountId' | 'thumbnail'>
> {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

let userCounter = 0;

/**
 * Generate unique user data with defaults
 */
export function buildUser(overrides: UserData = {}): Required<UserData> {
  const index = ++userCounter;
  return {
    id: crypto.randomUUID(),
    username: `testuser${index}`,
    name: `Test User ${index}`,
    email: `testuser${index}@example.com`,
    thumbnail: null,
    passwordHash: null,
    plexAccountId: null,
    role: 'member',
    aggregateTrustScore: 100,
    totalViolations: 0,
    ...overrides,
  };
}

/**
 * Create a user in the database
 */
export async function createTestUser(overrides: UserData = {}): Promise<CreatedUser> {
  const data = buildUser(overrides);

  const result = await executeRawSql(`
    INSERT INTO users (
      id, username, name, email, thumbnail, password_hash, plex_account_id,
      role, aggregate_trust_score, total_violations
    ) VALUES (
      '${data.id}',
      '${data.username}',
      ${data.name ? `'${data.name}'` : 'NULL'},
      ${data.email ? `'${data.email}'` : 'NULL'},
      ${data.thumbnail ? `'${data.thumbnail}'` : 'NULL'},
      ${data.passwordHash ? `'${data.passwordHash}'` : 'NULL'},
      ${data.plexAccountId ? `'${data.plexAccountId}'` : 'NULL'},
      '${data.role}',
      ${data.aggregateTrustScore},
      ${data.totalViolations}
    )
    RETURNING *
  `);

  return mapUserRow(result.rows[0]);
}

/**
 * Create an owner user (with login access)
 */
export async function createTestOwner(overrides: UserData = {}): Promise<CreatedUser> {
  return createTestUser({
    role: 'owner',
    ...overrides,
  });
}

/**
 * Create an admin user
 */
export async function createTestAdmin(overrides: UserData = {}): Promise<CreatedUser> {
  return createTestUser({
    role: 'admin',
    ...overrides,
  });
}

/**
 * Create a member user (no login access)
 */
export async function createTestMember(overrides: UserData = {}): Promise<CreatedUser> {
  return createTestUser({
    role: 'member',
    ...overrides,
  });
}

/**
 * Create multiple users
 */
export async function createTestUsers(
  count: number,
  overrides: UserData = {}
): Promise<CreatedUser[]> {
  const users: CreatedUser[] = [];
  for (let i = 0; i < count; i++) {
    users.push(await createTestUser(overrides));
  }
  return users;
}

/**
 * Map database row to typed user object
 */
function mapUserRow(row: Record<string, unknown>): CreatedUser {
  return {
    id: row.id as string,
    username: row.username as string,
    name: row.name as string | null,
    email: row.email as string | null,
    role: row.role as 'owner' | 'admin' | 'viewer' | 'member' | 'disabled' | 'pending',
    aggregateTrustScore: row.aggregate_trust_score as number,
    totalViolations: row.total_violations as number,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Reset user counter (call in beforeEach if needed)
 */
export function resetUserCounter(): void {
  userCounter = 0;
}
