/**
 * Server Filtering Utility Tests
 *
 * Tests the server access control functions:
 * - buildServerAccessCondition: Build SQL conditions for server access
 * - filterByServerAccess: Filter arrays by server access
 * - hasServerAccess: Check if user has server access
 * - validateServerAccess: Validate and return error message
 */

import { describe, it, expect } from 'vitest';
import type { AuthUser } from '@tracearr/shared';
import {
  buildMultiServerFragment,
  buildServerAccessCondition,
  filterByServerAccess,
  hasServerAccess,
  resolveServerIds,
  validateServerAccess,
} from '../serverFiltering.js';
import { ForbiddenError } from '../errors.js';
import type { Column } from 'drizzle-orm';
import { renderSql } from '../../test/helpers.js';

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

const memberUser: AuthUser = {
  userId: 'member-1',
  username: 'member',
  role: 'member',
  serverIds: ['server-1', 'server-2', 'server-3'],
};

describe('resolveServerIds', () => {
  it('returns undefined for owner with no filter (all servers)', () => {
    expect(resolveServerIds(ownerUser, undefined, undefined)).toBeUndefined();
  });

  it('returns single serverId when legacy param is used', () => {
    expect(resolveServerIds(ownerUser, 'server-1', undefined)).toEqual(['server-1']);
  });

  it('returns serverIds array when provided', () => {
    expect(resolveServerIds(ownerUser, undefined, ['server-1', 'server-2'])).toEqual([
      'server-1',
      'server-2',
    ]);
  });

  it('serverIds takes precedence over serverId', () => {
    expect(resolveServerIds(ownerUser, 'server-1', ['server-2', 'server-3'])).toEqual([
      'server-2',
      'server-3',
    ]);
  });

  it('intersects with member accessible servers', () => {
    expect(resolveServerIds(memberUser, undefined, ['server-1', 'server-d'])).toEqual(['server-1']);
  });

  it('returns member accessible servers when no filter', () => {
    expect(resolveServerIds(memberUser, undefined, undefined)).toEqual([
      'server-1',
      'server-2',
      'server-3',
    ]);
  });

  it('returns empty array when member requests inaccessible server', () => {
    expect(resolveServerIds(memberUser, undefined, ['server-d'])).toEqual([]);
  });

  it('returns the single serverId when member has access', () => {
    expect(resolveServerIds(memberUser, 'server-1', undefined)).toEqual(['server-1']);
  });

  it('throws when member requests an inaccessible single serverId', () => {
    expect(() => resolveServerIds(memberUser, 'server-d', undefined)).toThrow(ForbiddenError);
  });

  it('returns an empty array instead of throwing when strict is false', () => {
    expect(resolveServerIds(memberUser, 'server-d', undefined, { strict: false })).toEqual([]);
  });
});

function toSqlString(fragment: ReturnType<typeof buildMultiServerFragment>): string {
  return renderSql(fragment, () => '?').sql;
}

describe('buildMultiServerFragment', () => {
  it('returns empty SQL for undefined (owner all-servers)', () => {
    expect(toSqlString(buildMultiServerFragment(undefined))).toBe('');
  });

  it('returns AND false for empty array (no accessible servers)', () => {
    expect(toSqlString(buildMultiServerFragment([]))).toBe('AND false');
  });

  it('returns AND col = ? for single server', () => {
    expect(toSqlString(buildMultiServerFragment(['server-abc']))).toBe('AND server_id = ?');
  });

  it('returns AND col IN (?, ?) for multiple servers', () => {
    expect(toSqlString(buildMultiServerFragment(['server-1', 'server-2']))).toBe(
      'AND server_id IN (?, ?)'
    );
  });

  it('respects a custom columnRef', () => {
    expect(toSqlString(buildMultiServerFragment(['server-1'], 'su.server_id'))).toBe(
      'AND su.server_id = ?'
    );
  });
});
