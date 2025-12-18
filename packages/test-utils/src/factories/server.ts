/**
 * Server factory for test data generation
 *
 * Creates server entities with sensible defaults.
 */

import { executeRawSql } from '../db/pool.js';

export type ServerType = 'plex' | 'jellyfin' | 'emby';

export interface ServerData {
  id?: string;
  name?: string;
  type?: ServerType;
  url?: string;
  token?: string;
}

export interface CreatedServer extends Required<ServerData> {
  id: string;
  createdAt: Date;
  updatedAt: Date;
}

let serverCounter = 0;

/**
 * Generate unique server data with defaults
 */
export function buildServer(overrides: ServerData = {}): Required<ServerData> {
  const index = ++serverCounter;
  const type = overrides.type || 'plex';
  const port = type === 'plex' ? 32400 : type === 'jellyfin' ? 8096 : 8920;

  return {
    id: crypto.randomUUID(),
    name: `Test ${type.charAt(0).toUpperCase() + type.slice(1)} Server ${index}`,
    type,
    url: `http://localhost:${port}`,
    token: `test-${type}-token-${index}`,
    ...overrides,
  };
}

/**
 * Create a server in the database
 */
export async function createTestServer(overrides: ServerData = {}): Promise<CreatedServer> {
  const data = buildServer(overrides);

  const result = await executeRawSql(`
    INSERT INTO servers (id, name, type, url, token)
    VALUES (
      '${data.id}',
      '${data.name}',
      '${data.type}',
      '${data.url}',
      '${data.token}'
    )
    RETURNING *
  `);

  return mapServerRow(result.rows[0]);
}

/**
 * Create a Plex server
 */
export async function createTestPlexServer(
  overrides: Omit<ServerData, 'type'> = {}
): Promise<CreatedServer> {
  return createTestServer({
    type: 'plex',
    url: 'http://localhost:32400',
    ...overrides,
  });
}

/**
 * Create a Jellyfin server
 */
export async function createTestJellyfinServer(
  overrides: Omit<ServerData, 'type'> = {}
): Promise<CreatedServer> {
  return createTestServer({
    type: 'jellyfin',
    url: 'http://localhost:8096',
    ...overrides,
  });
}

/**
 * Create an Emby server
 */
export async function createTestEmbyServer(
  overrides: Omit<ServerData, 'type'> = {}
): Promise<CreatedServer> {
  return createTestServer({
    type: 'emby',
    url: 'http://localhost:8920',
    ...overrides,
  });
}

/**
 * Create multiple servers
 */
export async function createTestServers(
  count: number,
  overrides: ServerData = {}
): Promise<CreatedServer[]> {
  const servers: CreatedServer[] = [];
  for (let i = 0; i < count; i++) {
    servers.push(await createTestServer(overrides));
  }
  return servers;
}

/**
 * Map database row to typed server object
 */
function mapServerRow(row: Record<string, unknown>): CreatedServer {
  return {
    id: row.id as string,
    name: row.name as string,
    type: row.type as ServerType,
    url: row.url as string,
    token: row.token as string,
    createdAt: row.created_at as Date,
    updatedAt: row.updated_at as Date,
  };
}

/**
 * Reset server counter
 */
export function resetServerCounter(): void {
  serverCounter = 0;
}
