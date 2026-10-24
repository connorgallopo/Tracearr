/**
 * User Service Tests
 *
 * Tests for the userService module that centralizes user operations.
 * Uses mocked database to test business logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { SQL } from 'drizzle-orm';
import { renderSql } from '../../test/helpers.js';

// Mock the database
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    transaction: vi.fn(),
  },
}));

// Import after mocking
import { db } from '../../db/client.js';
import {
  getUserById,
  requireUserById,
  getServerUserByExternalId,
  getOwnerUser,
  syncUserFromMediaServer,
  applyTrustChange,
  getServerUserDisplayNames,
  recomputeIdentityAggregates,
  updateUser,
  UserNotFoundError,
} from '../userService.js';

// Helper to create mock user (identity layer)
function createMockUser(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    username: 'testuser',
    name: null,
    email: 'test@example.com',
    thumbnail: null,
    passwordHash: null,
    plexAccountId: null,
    role: 'member',
    aggregateTrustScore: 100,
    totalViolations: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to create mock server user (account on specific server)
function createMockServerUser(overrides: Record<string, unknown> = {}) {
  return {
    id: randomUUID(),
    userId: randomUUID(),
    serverId: randomUUID(),
    externalId: 'external-123',
    username: 'serveruser',
    email: null,
    thumbUrl: null,
    isServerAdmin: false,
    libraryIds: null,
    trustScore: 100,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// Helper to setup select chain mock
function mockSelectChain(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
    orderBy: vi.fn().mockReturnThis(),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getUserById', () => {
  it('should return user when found', async () => {
    const mockUser = createMockUser();
    mockSelectChain([mockUser]);

    const result = await getUserById(mockUser.id);

    expect(result).toEqual(mockUser);
    expect(db.select).toHaveBeenCalled();
  });

  it('should return null when user not found', async () => {
    mockSelectChain([]);

    const result = await getUserById('non-existent-id');

    expect(result).toBeNull();
  });
});

describe('requireUserById', () => {
  it('should return user when found', async () => {
    const mockUser = createMockUser();
    mockSelectChain([mockUser]);

    const result = await requireUserById(mockUser.id);

    expect(result).toEqual(mockUser);
  });

  it('should throw UserNotFoundError when user not found', async () => {
    mockSelectChain([]);

    await expect(requireUserById('non-existent-id')).rejects.toThrow(UserNotFoundError);
    await expect(requireUserById('non-existent-id')).rejects.toThrow(
      "User with ID 'non-existent-id' not found"
    );
  });
});

describe('getServerUserByExternalId', () => {
  it('should return server user when found by serverId and externalId', async () => {
    const mockServerUser = createMockServerUser();
    mockSelectChain([mockServerUser]);

    const result = await getServerUserByExternalId(mockServerUser.serverId, 'external-123');

    expect(result).toEqual(mockServerUser);
  });

  it('should return null when not found', async () => {
    mockSelectChain([]);

    const result = await getServerUserByExternalId('server-id', 'non-existent');

    expect(result).toBeNull();
  });
});

describe('getOwnerUser', () => {
  it('should return owner user when exists', async () => {
    const mockOwner = createMockUser({ role: 'owner' });
    mockSelectChain([mockOwner]);

    const result = await getOwnerUser();

    expect(result).toEqual(mockOwner);
    expect(result?.role).toBe('owner');
  });

  it('should return null when no owner exists', async () => {
    mockSelectChain([]);

    const result = await getOwnerUser();

    expect(result).toBeNull();
  });
});

describe('syncUserFromMediaServer', () => {
  const serverId = randomUUID();
  const mediaUser = {
    id: 'external-456',
    username: 'plexuser',
    email: 'plex@example.com',
    thumb: 'https://plex.tv/thumb.jpg',
    isAdmin: false,
  };

  it('should create new server user when not exists', async () => {
    const now = new Date();
    const userId = randomUUID();
    const newServerUser = createMockServerUser({
      externalId: mediaUser.id,
      username: mediaUser.username,
      serverId,
      userId,
      createdAt: now,
      updatedAt: now,
    });
    const newUser = createMockUser({
      id: userId,
      username: mediaUser.username,
    });

    // First: check for existing server user (returns empty) - before transaction
    const selectChain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(selectChain as never);

    // Mock transaction - passes tx object to callback and returns result
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      // Create mock tx with select and insert methods
      const tx = {
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue([]), // No existing user by email
        }),
        insert: vi
          .fn()
          .mockReturnValueOnce({
            values: vi.fn().mockReturnThis(),
            returning: vi.fn().mockResolvedValue([newUser]), // Create user
          })
          .mockReturnValueOnce({
            values: vi.fn().mockReturnThis(),
            returning: vi.fn().mockResolvedValue([newServerUser]), // Create server user
          }),
      };
      return callback(tx as never);
    });

    const result = await syncUserFromMediaServer(serverId, mediaUser);

    expect(result).not.toBeNull();
    expect(result!.created).toBe(true);
    expect(result!.serverUser.externalId).toBe(mediaUser.id);
    expect(result!.user.id).toBe(userId);
  });

  it('should update existing server user when exists', async () => {
    const userId = randomUUID();
    const serverUserId = randomUUID();
    const existingServerUser = createMockServerUser({
      id: serverUserId,
      externalId: mediaUser.id,
      username: 'oldusername',
      serverId,
      userId,
    });
    const existingUser = createMockUser({
      id: userId,
      username: 'oldusername',
    });
    const updatedServerUser = createMockServerUser({
      id: serverUserId,
      externalId: mediaUser.id,
      username: mediaUser.username,
      serverId,
      userId,
    });

    // First: check for existing server user (returns existing)
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([{ ...existingServerUser, user: existingUser }]),
    } as never);

    // Update server user
    vi.mocked(db.update).mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updatedServerUser]),
    } as never);

    const result = await syncUserFromMediaServer(serverId, mediaUser);

    expect(result).not.toBeNull();
    expect(result!.created).toBe(false);
    expect(result!.serverUser.username).toBe(mediaUser.username);
  });
});

describe('updateUser', () => {
  function mockUpdateChain(result: unknown[]) {
    const set = vi.fn().mockReturnThis();
    const chain = {
      set,
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue(result),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);
    return set;
  }

  it('trims and lowercases a contact email before the column check sees it', async () => {
    const user = createMockUser();
    const set = mockUpdateChain([user]);

    await updateUser(user.id, { contactEmail: '  Contact@Example.COM \n' });

    expect(set.mock.calls[0]?.[0]).toMatchObject({ contactEmail: 'contact@example.com' });
  });

  it('stores a contact email of only whitespace as no contact email', async () => {
    const user = createMockUser();
    const set = mockUpdateChain([user]);

    await updateUser(user.id, { contactEmail: '   ' });

    expect(set.mock.calls[0]?.[0]).toMatchObject({ contactEmail: null });
  });

  it('leaves an explicit null and an absent key alone', async () => {
    const user = createMockUser();
    let set = mockUpdateChain([user]);
    await updateUser(user.id, { contactEmail: null });
    expect(set.mock.calls[0]?.[0]).toMatchObject({ contactEmail: null });

    set = mockUpdateChain([user]);
    await updateUser(user.id, { name: 'Renamed' });
    const [written] = set.mock.calls[0] ?? [];
    expect(written).toBeDefined();
    expect((written as { contactEmail?: string }).contactEmail).toBeUndefined();
  });
});

describe('applyTrustChange', () => {
  it('returns both sides of the one write and recomputes the identity rollup', async () => {
    const serverUserId = randomUUID();
    const userId = randomUUID();
    const updated = createMockServerUser({ id: serverUserId, userId, trustScore: 75 });

    const txUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([{ previous: 80, row: updated }]),
    });
    const txSelect = vi.fn().mockReturnValue({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([{ trust: 75, count: 0 }]),
    });
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      return callback({ update: txUpdate, select: txSelect } as never);
    });

    const result = await applyTrustChange(serverUserId, { mode: 'adjust', amount: -5 });

    expect(result?.previous).toBe(80);
    expect(result?.serverUser.trustScore).toBe(75);
    // Rollup recompute reads and writes within the same transaction
    expect(txSelect).toHaveBeenCalled();
    expect(txUpdate).toHaveBeenCalledTimes(2);
  });

  it('returns null when the account is already gone', async () => {
    const txUpdate = vi.fn().mockReturnValue({
      set: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    });
    vi.mocked(db.transaction).mockImplementation(async (callback) => {
      return callback({ update: txUpdate } as never);
    });

    expect(await applyTrustChange('non-existent', { mode: 'reset' })).toBeNull();
    expect(txUpdate).toHaveBeenCalledTimes(1);
  });
});

describe('UserNotFoundError', () => {
  it('should be instanceof Error', () => {
    const error = new UserNotFoundError('test-id');
    expect(error).toBeInstanceOf(Error);
  });

  it('should have correct name', () => {
    const error = new UserNotFoundError('test-id');
    expect(error.name).toBe('UserNotFoundError');
  });

  it('should format message with ID', () => {
    const error = new UserNotFoundError('abc-123');
    expect(error.message).toBe("User with ID 'abc-123' not found");
  });

  it('should format message without ID', () => {
    const error = new UserNotFoundError();
    expect(error.message).toBe('User not found');
  });

  it('should have HTTP status code 404', () => {
    const error = new UserNotFoundError('test');
    expect(error.statusCode).toBe(404);
  });

  it('should have error code from NotFoundError', () => {
    const error = new UserNotFoundError('test');
    expect(error.code).toBe('RES_001');
  });
});

describe('getServerUserDisplayNames', () => {
  function mockSelectWithLeftJoin(result: unknown[]) {
    const chain = {
      from: vi.fn().mockReturnThis(),
      leftJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(result),
    };
    vi.mocked(db.select).mockReturnValue(chain as never);
    return chain;
  }

  it('returns empty map without querying for empty input', async () => {
    const result = await getServerUserDisplayNames([]);
    expect(result).toEqual({});
    expect(db.select).not.toHaveBeenCalled();
  });

  it('returns id→name map using identityName when present', async () => {
    const rows = [
      { id: 'id-1', username: 'alice', identityName: 'Alice Smith' },
      { id: 'id-2', username: 'bob', identityName: null },
    ];
    mockSelectWithLeftJoin(rows);

    const result = await getServerUserDisplayNames(['id-1', 'id-2']);

    expect(result).toEqual({ 'id-1': 'Alice Smith', 'id-2': 'bob' });
  });

  it('issues a single query for multiple ids', async () => {
    mockSelectWithLeftJoin([{ id: 'id-1', username: 'u', identityName: null }]);

    await getServerUserDisplayNames(['id-1', 'id-2', 'id-3']);

    expect(db.select).toHaveBeenCalledTimes(1);
  });

  it('deduplicates ids before querying', async () => {
    const chain = mockSelectWithLeftJoin([{ id: 'id-1', username: 'u', identityName: null }]);

    await getServerUserDisplayNames(['id-1', 'id-1', 'id-1']);

    expect(db.select).toHaveBeenCalledTimes(1);
    expect(chain.where).toHaveBeenCalledTimes(1);
  });
});

describe('recomputeIdentityAggregates', () => {
  /** Chainable stub that records its builder arguments and resolves to `rows`. */
  function recordingChain(rows: unknown[]) {
    const chain: Record<string, unknown> = {
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(resolve, reject),
    };
    for (const method of ['from', 'innerJoin', 'where']) {
      chain[method] = vi.fn(() => chain);
    }
    return chain as { where: ReturnType<typeof vi.fn> } & Record<string, unknown>;
  }

  it('counts only completed policy runs into total_violations', async () => {
    const accountChain = recordingChain([{ trust: 80, firstJoinedAt: null, lastActivityAt: null }]);
    const violationChain = recordingChain([{ count: 2 }]);
    vi.mocked(db.select)
      .mockReturnValueOnce(accountChain as never)
      .mockReturnValueOnce(violationChain as never);
    const setSpy = vi.fn(() => ({ where: vi.fn(async () => undefined) }));
    vi.mocked(db.update).mockReturnValue({ set: setSpy } as never);

    await recomputeIdentityAggregates(randomUUID());

    const where = violationChain.where.mock.calls[0]?.[0] as SQL;
    const text = renderSql(where).sql.replace(/\s+/g, ' ').trim();
    expect(text).toContain('automation_runs.kind =');
    expect(text).toContain('automation_runs.outcome =');
    expect(text).toContain('automation_runs.dismissed_at is null');
    expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ totalViolations: 2 }));
  });
});
