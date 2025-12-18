/**
 * User Service Tests
 *
 * Tests for the userService module that centralizes user operations.
 * Uses mocked database to test business logic in isolation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';

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
  getUserByPlexAccountId,
  getUserByUsername,
  getOwnerUser,
  getServerUserWithDetails,
  getUserWithStats,
  createOwnerUser,
  linkPlexAccount,
  syncUserFromMediaServer,
  updateServerUserTrustScore,
  getServerUsersByServer,
  batchSyncUsersFromMediaServer,
  UserNotFoundError,
  ServerUserNotFoundError,
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
    trustScore: 100,
    sessionCount: 0,
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

// Helper to setup update chain mock
function mockUpdateChain(result: unknown[]) {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
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

    const result = await getServerUserByExternalId(
      mockServerUser.serverId as string,
      'external-123'
    );

    expect(result).toEqual(mockServerUser);
  });

  it('should return null when not found', async () => {
    mockSelectChain([]);

    const result = await getServerUserByExternalId('server-id', 'non-existent');

    expect(result).toBeNull();
  });
});

describe('getUserByPlexAccountId', () => {
  it('should return user when found by Plex account ID', async () => {
    const mockUser = createMockUser({ plexAccountId: 'plex-123' });
    mockSelectChain([mockUser]);

    const result = await getUserByPlexAccountId('plex-123');

    expect(result).toEqual(mockUser);
  });

  it('should return null when not found', async () => {
    mockSelectChain([]);

    const result = await getUserByPlexAccountId('non-existent');

    expect(result).toBeNull();
  });
});

describe('getUserByUsername', () => {
  it('should return user when found by username', async () => {
    const mockUser = createMockUser({ username: 'johndoe' });
    mockSelectChain([mockUser]);

    const result = await getUserByUsername('johndoe');

    expect(result).toEqual(mockUser);
  });

  it('should return null when not found', async () => {
    mockSelectChain([]);

    const result = await getUserByUsername('nonexistent');

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

describe('getServerUserWithDetails', () => {
  it('should return server user with details when found', async () => {
    const serverUserId = randomUUID();
    const userId = randomUUID();
    const serverId = randomUUID();
    const serverUserWithDetails = {
      id: serverUserId,
      userId,
      serverId,
      externalId: 'ext-123',
      username: 'testuser',
      email: 'test@example.com',
      thumbUrl: null,
      isServerAdmin: false,
      trustScore: 100,
      sessionCount: 5,
      createdAt: new Date(),
      updatedAt: new Date(),
      userName: 'Test User',
      userThumbnail: null,
      userEmail: 'test@example.com',
      userRole: 'member',
      userAggregateTrustScore: 100,
      serverName: 'My Plex Server',
      serverType: 'plex',
    };

    // Mock the join query chain
    const chain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([serverUserWithDetails]),
    };
    vi.mocked(db.select).mockReturnValue(chain as never);

    const result = await getServerUserWithDetails(serverUserId);

    expect(result).toBeDefined();
    expect(result?.server.name).toBe('My Plex Server');
  });

  it('should return null when server user not found', async () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(chain as never);

    const result = await getServerUserWithDetails('non-existent');

    expect(result).toBeNull();
  });
});

describe('getUserWithStats', () => {
  it('should return user with stats when found', async () => {
    const userId = randomUUID();
    const serverUserId = randomUUID();
    const serverId = randomUUID();
    const mockUser = createMockUser({ id: userId });
    const serverUserRow = {
      id: serverUserId,
      serverId,
      serverName: 'My Server',
      serverType: 'plex',
      username: 'testuser',
      thumbUrl: null,
      trustScore: 100,
      sessionCount: 5,
    };
    const stats = { totalSessions: 42, totalWatchTime: BigInt(3600000) };

    // 1. getUserById - returns identity user
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([mockUser]),
    } as never);

    // 2. Get server users with join - returns array (no limit)
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([serverUserRow]),
    } as never);

    // 3. Get stats from sessions
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([stats]),
    } as never);

    const result = await getUserWithStats(userId);

    expect(result).not.toBeNull();
    expect(result?.stats.totalSessions).toBe(42);
    expect(result?.stats.totalWatchTime).toBe(3600000);
    expect(result?.serverUsers).toHaveLength(1);
  });

  it('should return null when user not found', async () => {
    // getUserById returns null
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([]),
    } as never);

    const result = await getUserWithStats('non-existent');

    expect(result).toBeNull();
  });

  it('should handle zero stats when user has no server accounts', async () => {
    const userId = randomUUID();
    const mockUser = createMockUser({ id: userId });

    // 1. getUserById returns user
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue([mockUser]),
    } as never);

    // 2. No server users
    vi.mocked(db.select).mockReturnValueOnce({
      from: vi.fn().mockReturnThis(),
      innerJoin: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    } as never);

    // Stats query is not called when no server users

    const result = await getUserWithStats(userId);

    expect(result?.stats.totalSessions).toBe(0);
    expect(result?.stats.totalWatchTime).toBe(0);
    expect(result?.serverUsers).toHaveLength(0);
  });
});

describe('createOwnerUser', () => {
  it('should create owner user with password', async () => {
    const ownerUser = createMockUser({
      username: 'admin',
      role: 'owner',
      passwordHash: 'hashed-password',
    });

    const chain = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([ownerUser]),
    };
    vi.mocked(db.insert).mockReturnValue(chain as never);

    const result = await createOwnerUser({
      username: 'admin',
      passwordHash: 'hashed-password',
    });

    expect(result.role).toBe('owner');
    expect(result.username).toBe('admin');
    expect(db.insert).toHaveBeenCalled();
  });

  it('should create owner user with Plex account', async () => {
    const ownerUser = createMockUser({
      username: 'plexadmin',
      role: 'owner',
      plexAccountId: 'plex-12345',
      thumbUrl: 'https://plex.tv/avatar.jpg',
    });

    const chain = {
      values: vi.fn().mockReturnThis(),
      onConflictDoUpdate: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([ownerUser]),
    };
    vi.mocked(db.insert).mockReturnValue(chain as never);

    const result = await createOwnerUser({
      username: 'plexadmin',
      plexAccountId: 'plex-12345',
      thumbnail: 'https://plex.tv/avatar.jpg',
    });

    expect(result.role).toBe('owner');
    expect(result.plexAccountId).toBe('plex-12345');
  });
});

describe('linkPlexAccount', () => {
  it('should link Plex account to existing user', async () => {
    const userId = randomUUID();
    const updatedUser = createMockUser({
      id: userId,
      plexAccountId: 'plex-linked',
      thumbnail: 'https://plex.tv/thumb.jpg',
    });

    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updatedUser]),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);

    const result = await linkPlexAccount(userId, 'plex-linked', 'https://plex.tv/thumb.jpg');

    expect(result.plexAccountId).toBe('plex-linked');
    expect(result.thumbnail).toBe('https://plex.tv/thumb.jpg');
  });

  it('should link Plex account without thumb', async () => {
    const userId = randomUUID();
    const updatedUser = createMockUser({
      id: userId,
      plexAccountId: 'plex-no-thumb',
    });

    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([updatedUser]),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);

    const result = await linkPlexAccount(userId, 'plex-no-thumb');

    expect(result.plexAccountId).toBe('plex-no-thumb');
  });

  it('should throw UserNotFoundError when user not found', async () => {
    const chain = {
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      returning: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.update).mockReturnValue(chain as never);

    await expect(linkPlexAccount('non-existent', 'plex-123')).rejects.toThrow(UserNotFoundError);
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

    expect(result.created).toBe(true);
    expect(result.serverUser.externalId).toBe(mediaUser.id);
    expect(result.user.id).toBe(userId);
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

    expect(result.created).toBe(false);
    expect(result.serverUser.username).toBe(mediaUser.username);
  });
});

describe('updateServerUserTrustScore', () => {
  it('should update trust score successfully', async () => {
    const serverUserId = randomUUID();
    const updatedServerUser = createMockServerUser({ id: serverUserId, trustScore: 80 });
    mockUpdateChain([updatedServerUser]);

    const result = await updateServerUserTrustScore(serverUserId, 80);

    expect(result.trustScore).toBe(80);
  });

  it('should throw ServerUserNotFoundError when server user not found', async () => {
    mockUpdateChain([]);

    await expect(updateServerUserTrustScore('non-existent', 50)).rejects.toThrow(
      ServerUserNotFoundError
    );
  });
});

describe('getServerUsersByServer', () => {
  it('should return map of server users by externalId', async () => {
    const serverId = randomUUID();
    const serverUsers = [
      createMockServerUser({ externalId: 'ext-1', username: 'user1', serverId }),
      createMockServerUser({ externalId: 'ext-2', username: 'user2', serverId }),
      createMockServerUser({ externalId: 'ext-3', username: 'user3', serverId }),
    ];

    // Setup select to return array directly (no limit)
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(serverUsers),
    };
    vi.mocked(db.select).mockReturnValue(chain as never);

    const result = await getServerUsersByServer(serverId);

    expect(result.size).toBe(3);
    expect(result.get('ext-1')?.username).toBe('user1');
    expect(result.get('ext-2')?.username).toBe('user2');
    expect(result.get('ext-3')?.username).toBe('user3');
  });

  it('should return empty map when no server users', async () => {
    const chain = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue([]),
    };
    vi.mocked(db.select).mockReturnValue(chain as never);

    const result = await getServerUsersByServer(randomUUID());

    expect(result.size).toBe(0);
  });
});

describe('batchSyncUsersFromMediaServer', () => {
  it('should return zeros for empty input', async () => {
    const result = await batchSyncUsersFromMediaServer(randomUUID(), []);

    expect(result).toEqual({ added: 0, updated: 0 });
    expect(db.insert).not.toHaveBeenCalled();
  });

  // Full sync behavior is tested in test/integration/userService.integration.test.ts
  // Unit tests for the loop logic are covered by syncUserFromMediaServer tests above
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
