/**
 * Server Filtering Utility Tests
 *
 * Tests the server access control functions:
 * - buildServerAccessCondition: Build SQL conditions for server access
 * - buildServerFilterCondition: Build conditions with explicit serverId validation
 * - filterByServerAccess: Filter arrays by server access
 * - hasServerAccess: Check if user has server access
 * - validateServerAccess: Validate and return error message
 */

import { describe, it, expect } from 'vitest';
import type { AuthUser } from '@tracearr/shared';
import {
  buildServerAccessCondition,
  buildServerFilterCondition,
  filterByServerAccess,
  hasServerAccess,
  validateServerAccess,
} from '../serverFiltering.js';
import type { Column } from 'drizzle-orm';

// Mock column for testing SQL condition builders
const mockServerIdColumn = {
  name: 'serverId',
} as unknown as Column;

// Test fixtures
const ownerUser: AuthUser = {
  userId: 'owner-1',
  username: 'owner',
  role: 'owner',
  serverIds: [],
};

const adminUserSingleServer: AuthUser = {
  userId: 'admin-1',
  username: 'admin',
  role: 'admin',
  serverIds: ['server-1'],
};

const adminUserMultiServer: AuthUser = {
  userId: 'admin-2',
  username: 'admin2',
  role: 'admin',
  serverIds: ['server-1', 'server-2'],
};

const adminUserNoServers: AuthUser = {
  userId: 'admin-3',
  username: 'admin3',
  role: 'admin',
  serverIds: [],
};

describe('filterByServerAccess', () => {
  const items = [
    { id: '1', serverId: 'server-1', name: 'Item 1' },
    { id: '2', serverId: 'server-2', name: 'Item 2' },
    { id: '3', serverId: 'server-3', name: 'Item 3' },
  ];

  it('should return all items for owner', () => {
    const result = filterByServerAccess(items, ownerUser);
    expect(result).toHaveLength(3);
    expect(result).toEqual(items);
  });

  it('should filter to accessible servers for admin', () => {
    const result = filterByServerAccess(items, adminUserSingleServer);
    expect(result).toHaveLength(1);
    expect(result[0]?.serverId).toBe('server-1');
  });

  it('should filter to multiple servers for admin with multi-server access', () => {
    const result = filterByServerAccess(items, adminUserMultiServer);
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.serverId)).toEqual(['server-1', 'server-2']);
  });

  it('should return empty array for admin with no server access', () => {
    const result = filterByServerAccess(items, adminUserNoServers);
    expect(result).toHaveLength(0);
  });

  it('should handle empty items array', () => {
    const result = filterByServerAccess([], adminUserSingleServer);
    expect(result).toHaveLength(0);
  });
});

describe('hasServerAccess', () => {
  it('should return true for owner regardless of serverId', () => {
    expect(hasServerAccess(ownerUser, 'any-server')).toBe(true);
    expect(hasServerAccess(ownerUser, 'server-1')).toBe(true);
    expect(hasServerAccess(ownerUser, '')).toBe(true);
  });

  it('should return true when user has access to specific server', () => {
    expect(hasServerAccess(adminUserSingleServer, 'server-1')).toBe(true);
  });

  it('should return false when user does not have access', () => {
    expect(hasServerAccess(adminUserSingleServer, 'server-2')).toBe(false);
    expect(hasServerAccess(adminUserSingleServer, 'unknown')).toBe(false);
  });

  it('should return false for user with no server access', () => {
    expect(hasServerAccess(adminUserNoServers, 'server-1')).toBe(false);
  });

  it('should check multiple servers correctly', () => {
    expect(hasServerAccess(adminUserMultiServer, 'server-1')).toBe(true);
    expect(hasServerAccess(adminUserMultiServer, 'server-2')).toBe(true);
    expect(hasServerAccess(adminUserMultiServer, 'server-3')).toBe(false);
  });
});

describe('validateServerAccess', () => {
  it('should return null for owner (access granted)', () => {
    expect(validateServerAccess(ownerUser, 'any-server')).toBeNull();
  });

  it('should return null when user has access', () => {
    expect(validateServerAccess(adminUserSingleServer, 'server-1')).toBeNull();
  });

  it('should return error message when access denied', () => {
    const error = validateServerAccess(adminUserSingleServer, 'server-2');
    expect(error).toBe('You do not have access to this server');
  });

  it('should return error message for user with no servers', () => {
    const error = validateServerAccess(adminUserNoServers, 'server-1');
    expect(error).toBe('You do not have access to this server');
  });
});

describe('buildServerAccessCondition', () => {
  it('should return undefined for owner (no filtering)', () => {
    const result = buildServerAccessCondition(ownerUser, mockServerIdColumn);
    expect(result).toBeUndefined();
  });

  it('should return sql`false` for user with no server access', () => {
    const result = buildServerAccessCondition(adminUserNoServers, mockServerIdColumn);
    expect(result).toBeDefined();
    // The result should be a SQL object (we just verify it's defined)
  });

  it('should return equality condition for single server', () => {
    const result = buildServerAccessCondition(adminUserSingleServer, mockServerIdColumn);
    expect(result).toBeDefined();
    // Single server should use eq() which is more efficient
  });

  it('should return IN clause for multiple servers', () => {
    const result = buildServerAccessCondition(adminUserMultiServer, mockServerIdColumn);
    expect(result).toBeDefined();
    // Multiple servers should use inArray()
  });
});

describe('buildServerFilterCondition', () => {
  it('should return error when user lacks access to requested server', () => {
    const result = buildServerFilterCondition(
      adminUserSingleServer,
      'server-2',
      mockServerIdColumn
    );
    expect(result.error).toBe('You do not have access to this server');
    expect(result.condition).toBeUndefined();
  });

  it('should return condition when user has access to requested server', () => {
    const result = buildServerFilterCondition(
      adminUserSingleServer,
      'server-1',
      mockServerIdColumn
    );
    expect(result.error).toBeNull();
    expect(result.condition).toBeDefined();
  });

  it('should allow owner to access any server', () => {
    const result = buildServerFilterCondition(ownerUser, 'any-server', mockServerIdColumn);
    expect(result.error).toBeNull();
    expect(result.condition).toBeDefined();
  });

  it('should fall back to server access condition when no explicit serverId', () => {
    const result = buildServerFilterCondition(adminUserSingleServer, undefined, mockServerIdColumn);
    expect(result.error).toBeNull();
    // Should return the buildServerAccessCondition result
  });

  it('should return undefined condition for owner with no explicit serverId', () => {
    const result = buildServerFilterCondition(ownerUser, undefined, mockServerIdColumn);
    expect(result.error).toBeNull();
    expect(result.condition).toBeUndefined(); // Owners see all
  });
});
