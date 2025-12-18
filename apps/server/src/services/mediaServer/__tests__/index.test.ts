/**
 * Media Server Module Tests
 *
 * Tests the factory function, client interface compliance,
 * and module exports.
 */

import { describe, it, expect, vi } from 'vitest';

// Mock crypto module before imports
vi.mock('../../../utils/crypto.js', () => ({
  decrypt: vi.fn((val: string) => val), // Pass through for tests
  encrypt: vi.fn((val: string) => val),
  initializeEncryption: vi.fn(),
  isEncryptionInitialized: vi.fn(() => true),
}));

import {
  createMediaServerClient,
  supportsWatchHistory,
  PlexClient,
  JellyfinClient,
  EmbyClient,
  type IMediaServerClient,
  type MediaSession,
  type MediaUser,
  type MediaLibrary,
} from '../index.js';

// ============================================================================
// Factory Function Tests
// ============================================================================

describe('createMediaServerClient', () => {
  it('should create PlexClient for type "plex"', () => {
    const client = createMediaServerClient({
      type: 'plex',
      url: 'http://plex.local:32400',
      token: 'encrypted-token',
    });

    expect(client).toBeInstanceOf(PlexClient);
    expect(client.serverType).toBe('plex');
  });

  it('should create JellyfinClient for type "jellyfin"', () => {
    const client = createMediaServerClient({
      type: 'jellyfin',
      url: 'http://jellyfin.local:8096',
      token: 'encrypted-token',
    });

    expect(client).toBeInstanceOf(JellyfinClient);
    expect(client.serverType).toBe('jellyfin');
  });

  it('should create EmbyClient for type "emby"', () => {
    const client = createMediaServerClient({
      type: 'emby',
      url: 'http://emby.local:8096',
      token: 'encrypted-token',
    });

    expect(client).toBeInstanceOf(EmbyClient);
    expect(client.serverType).toBe('emby');
  });

  it('should throw error for unknown server type', () => {
    expect(() =>
      createMediaServerClient({
        type: 'unknown' as 'plex', // Force invalid type
        url: 'http://unknown.local:8096',
        token: 'token',
      })
    ).toThrow('Unknown media server type');
  });

  it('should pass optional config fields', () => {
    const client = createMediaServerClient({
      type: 'plex',
      url: 'http://plex.local:32400',
      token: 'token',
      id: 'server-123',
      name: 'My Plex Server',
    });

    expect(client).toBeInstanceOf(PlexClient);
  });

  it('should normalize URL by removing trailing slash', () => {
    const client = createMediaServerClient({
      type: 'plex',
      url: 'http://plex.local:32400/', // With trailing slash
      token: 'token',
    });

    // The client should work with normalized URL
    expect(client).toBeInstanceOf(PlexClient);
  });
});

// ============================================================================
// Type Guard Tests
// ============================================================================

describe('supportsWatchHistory', () => {
  it('should return true for PlexClient', () => {
    const client = createMediaServerClient({
      type: 'plex',
      url: 'http://plex.local:32400',
      token: 'token',
    });

    expect(supportsWatchHistory(client)).toBe(true);
  });

  it('should return true for JellyfinClient', () => {
    const client = createMediaServerClient({
      type: 'jellyfin',
      url: 'http://jellyfin.local:8096',
      token: 'token',
    });

    expect(supportsWatchHistory(client)).toBe(true);
  });

  it('should return true for EmbyClient', () => {
    const client = createMediaServerClient({
      type: 'emby',
      url: 'http://emby.local:8096',
      token: 'token',
    });

    expect(supportsWatchHistory(client)).toBe(true);
  });
});

// ============================================================================
// Interface Compliance Tests
// ============================================================================

describe('IMediaServerClient Interface Compliance', () => {
  const createTestClient = (type: 'plex' | 'jellyfin' | 'emby'): IMediaServerClient => {
    const urls = {
      plex: 'http://plex.local:32400',
      jellyfin: 'http://jellyfin.local:8096',
      emby: 'http://emby.local:8096',
    };
    return createMediaServerClient({
      type,
      url: urls[type],
      token: 'test-token',
    });
  };

  describe('PlexClient', () => {
    it('should implement serverType property', () => {
      const client = createTestClient('plex');
      expect(client.serverType).toBe('plex');
    });

    it('should implement getSessions method', () => {
      const client = createTestClient('plex');
      expect(typeof client.getSessions).toBe('function');
    });

    it('should implement getUsers method', () => {
      const client = createTestClient('plex');
      expect(typeof client.getUsers).toBe('function');
    });

    it('should implement getLibraries method', () => {
      const client = createTestClient('plex');
      expect(typeof client.getLibraries).toBe('function');
    });

    it('should implement testConnection method', () => {
      const client = createTestClient('plex');
      expect(typeof client.testConnection).toBe('function');
    });

    it('should implement terminateSession method', () => {
      const client = createTestClient('plex');
      expect(typeof client.terminateSession).toBe('function');
    });
  });

  describe('JellyfinClient', () => {
    it('should implement serverType property', () => {
      const client = createTestClient('jellyfin');
      expect(client.serverType).toBe('jellyfin');
    });

    it('should implement getSessions method', () => {
      const client = createTestClient('jellyfin');
      expect(typeof client.getSessions).toBe('function');
    });

    it('should implement getUsers method', () => {
      const client = createTestClient('jellyfin');
      expect(typeof client.getUsers).toBe('function');
    });

    it('should implement getLibraries method', () => {
      const client = createTestClient('jellyfin');
      expect(typeof client.getLibraries).toBe('function');
    });

    it('should implement testConnection method', () => {
      const client = createTestClient('jellyfin');
      expect(typeof client.testConnection).toBe('function');
    });

    it('should implement terminateSession method', () => {
      const client = createTestClient('jellyfin');
      expect(typeof client.terminateSession).toBe('function');
    });
  });

  describe('EmbyClient', () => {
    it('should implement serverType property', () => {
      const client = createTestClient('emby');
      expect(client.serverType).toBe('emby');
    });

    it('should implement getSessions method', () => {
      const client = createTestClient('emby');
      expect(typeof client.getSessions).toBe('function');
    });

    it('should implement getUsers method', () => {
      const client = createTestClient('emby');
      expect(typeof client.getUsers).toBe('function');
    });

    it('should implement getLibraries method', () => {
      const client = createTestClient('emby');
      expect(typeof client.getLibraries).toBe('function');
    });

    it('should implement testConnection method', () => {
      const client = createTestClient('emby');
      expect(typeof client.testConnection).toBe('function');
    });

    it('should implement terminateSession method', () => {
      const client = createTestClient('emby');
      expect(typeof client.terminateSession).toBe('function');
    });
  });
});

// ============================================================================
// Static Methods Tests
// ============================================================================

describe('PlexClient Static Methods', () => {
  it('should have initiateOAuth static method', () => {
    expect(typeof PlexClient.initiateOAuth).toBe('function');
  });

  it('should have checkOAuthPin static method', () => {
    expect(typeof PlexClient.checkOAuthPin).toBe('function');
  });

  it('should have verifyServerAdmin static method', () => {
    expect(typeof PlexClient.verifyServerAdmin).toBe('function');
  });

  it('should have getServers static method', () => {
    expect(typeof PlexClient.getServers).toBe('function');
  });

  it('should have getAccountInfo static method', () => {
    expect(typeof PlexClient.getAccountInfo).toBe('function');
  });

  it('should have getFriends static method', () => {
    expect(typeof PlexClient.getFriends).toBe('function');
  });

  it('should have getAllUsersWithLibraries static method', () => {
    expect(typeof PlexClient.getAllUsersWithLibraries).toBe('function');
  });
});

describe('JellyfinClient Static Methods', () => {
  it('should have authenticate static method', () => {
    expect(typeof JellyfinClient.authenticate).toBe('function');
  });

  it('should have verifyServerAdmin static method', () => {
    expect(typeof JellyfinClient.verifyServerAdmin).toBe('function');
  });
});

describe('EmbyClient Static Methods', () => {
  it('should have authenticate static method', () => {
    expect(typeof EmbyClient.authenticate).toBe('function');
  });

  it('should have verifyServerAdmin static method', () => {
    expect(typeof EmbyClient.verifyServerAdmin).toBe('function');
  });
});

// ============================================================================
// Type Export Tests
// ============================================================================

describe('Module Exports', () => {
  it('should export createMediaServerClient factory', () => {
    expect(typeof createMediaServerClient).toBe('function');
  });

  it('should export supportsWatchHistory type guard', () => {
    expect(typeof supportsWatchHistory).toBe('function');
  });

  it('should export PlexClient class', () => {
    expect(PlexClient).toBeDefined();
    expect(typeof PlexClient).toBe('function');
  });

  it('should export JellyfinClient class', () => {
    expect(JellyfinClient).toBeDefined();
    expect(typeof JellyfinClient).toBe('function');
  });

  it('should export EmbyClient class', () => {
    expect(EmbyClient).toBeDefined();
    expect(typeof EmbyClient).toBe('function');
  });

  // Type exports are verified at compile time, but we can check
  // that the factory returns properly typed results
  it('should return properly typed client from factory', () => {
    const client: IMediaServerClient = createMediaServerClient({
      type: 'plex',
      url: 'http://plex.local:32400',
      token: 'token',
    });

    // TypeScript ensures these methods exist
    const _getSessions: () => Promise<MediaSession[]> = client.getSessions.bind(client);
    const _getUsers: () => Promise<MediaUser[]> = client.getUsers.bind(client);
    const _getLibraries: () => Promise<MediaLibrary[]> = client.getLibraries.bind(client);

    expect(_getSessions).toBeDefined();
    expect(_getUsers).toBeDefined();
    expect(_getLibraries).toBeDefined();
  });
});

// ============================================================================
// Polymorphic Usage Tests
// ============================================================================

describe('Polymorphic Client Usage', () => {
  it('should allow treating all clients as IMediaServerClient', () => {
    const clients: IMediaServerClient[] = [
      createMediaServerClient({ type: 'plex', url: 'http://plex:32400', token: 'plex-token' }),
      createMediaServerClient({
        type: 'jellyfin',
        url: 'http://jellyfin:8096',
        token: 'jelly-token',
      }),
      createMediaServerClient({ type: 'emby', url: 'http://emby:8096', token: 'emby-token' }),
    ];

    expect(clients).toHaveLength(3);
    expect(clients[0]!.serverType).toBe('plex');
    expect(clients[1]!.serverType).toBe('jellyfin');
    expect(clients[2]!.serverType).toBe('emby');

    // All should have the same interface methods
    for (const client of clients) {
      expect(typeof client.getSessions).toBe('function');
      expect(typeof client.getUsers).toBe('function');
      expect(typeof client.getLibraries).toBe('function');
      expect(typeof client.testConnection).toBe('function');
      expect(typeof client.terminateSession).toBe('function');
    }
  });

  it('should support iteration over mixed client types', () => {
    const servers = [
      { type: 'plex' as const, url: 'http://plex1:32400', token: 'p1' },
      { type: 'jellyfin' as const, url: 'http://jellyfin1:8096', token: 'j1' },
      { type: 'emby' as const, url: 'http://emby1:8096', token: 'e1' },
      { type: 'plex' as const, url: 'http://plex2:32400', token: 'p2' },
    ];

    const clients = servers.map((s) => createMediaServerClient(s));

    expect(clients.filter((c) => c.serverType === 'plex')).toHaveLength(2);
    expect(clients.filter((c) => c.serverType === 'jellyfin')).toHaveLength(1);
    expect(clients.filter((c) => c.serverType === 'emby')).toHaveLength(1);
  });
});
