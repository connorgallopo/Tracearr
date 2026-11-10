/**
 * Media Server Module Tests
 *
 * Tests the factory function, client interface compliance,
 * and module exports.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ServerType } from '@tracearr/shared';

// Mock crypto module before imports
vi.mock('../../../utils/crypto.js', () => ({
  decrypt: vi.fn((val: string) => val), // Pass through for tests
  encrypt: vi.fn((val: string) => val),
  initializeEncryption: vi.fn(),
  isEncryptionInitialized: vi.fn(() => true),
}));

import {
  createMediaServerClient,
  createJellyfinEmbyClient,
  isJellyfinEmby,
  logoutUserToken,
  mediaBrowserAuthHeader,
  mediaBrowserTokenHeader,
  verifyServerAdmin,
  PlexClient,
  JellyfinClient,
  EmbyClient,
  type IMediaServerClient,
  type MediaSession,
  type MediaUser,
  type MediaLibrary,
} from '../index.js';
import { NOT_NEEDED } from '../types.js';

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
    ).toThrow('Unhandled value: unknown');
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
// Per-Server Decisions
// ============================================================================

describe('per-server decisions', () => {
  it('jellyfin and emby clients say seasons, albums and file checks are not needed', async () => {
    const clients: IMediaServerClient[] = [
      new JellyfinClient({ url: 'http://jellyfin.local:8096', token: 't' }),
      new EmbyClient({ url: 'http://emby.local:8096', token: 't' }),
    ];
    for (const client of clients) {
      expect(await client.getLibrarySeasons('lib')).toBe(NOT_NEEDED);
      expect(await client.getLibraryAlbums('lib')).toBe(NOT_NEEDED);
      expect(await client.checkFilesExist(['1'])).toBe(NOT_NEEDED);
    }
  });

  it('picks the auth header by server', () => {
    expect(mediaBrowserAuthHeader('jellyfin')).toBe('Authorization');
    expect(mediaBrowserAuthHeader('emby')).toBe('X-Emby-Authorization');
  });

  it('picks the token header by server', () => {
    expect(mediaBrowserTokenHeader('jellyfin', 't')).toEqual({
      Authorization: 'MediaBrowser Token="t"',
    });
    expect(mediaBrowserTokenHeader('emby', 't')).toEqual({ 'X-Emby-Token': 't' });
  });

  it('isJellyfinEmby is false for plex', () => {
    expect(isJellyfinEmby('plex')).toBe(false);
    expect(isJellyfinEmby('emby')).toBe(true);
  });

  it('creates the client class named by the server type', () => {
    const config = { url: 'http://emby.local:8096', token: 't' };
    expect(createJellyfinEmbyClient('jellyfin', config)).toBeInstanceOf(JellyfinClient);
    expect(createJellyfinEmbyClient('emby', config)).toBeInstanceOf(EmbyClient);
  });

  it('verifies admin through the class for the server type', async () => {
    const plex = vi.spyOn(PlexClient, 'verifyServerAdmin').mockResolvedValue({ success: true });
    const jellyfin = vi
      .spyOn(JellyfinClient, 'verifyServerAdmin')
      .mockResolvedValue({ success: true });
    const emby = vi.spyOn(EmbyClient, 'verifyServerAdmin').mockResolvedValue({ success: true });

    await verifyServerAdmin('plex', 'p', 'http://plex');
    await verifyServerAdmin('jellyfin', 'j', 'http://jellyfin');
    await verifyServerAdmin('emby', 'e', 'http://emby');

    expect(plex).toHaveBeenCalledExactlyOnceWith('p', 'http://plex');
    expect(jellyfin).toHaveBeenCalledExactlyOnceWith('j', 'http://jellyfin');
    expect(emby).toHaveBeenCalledExactlyOnceWith('e', 'http://emby');
  });

  it('logs a token out through the class for the server type', async () => {
    const jellyfin = vi.spyOn(JellyfinClient, 'logoutUserToken').mockResolvedValue();
    const emby = vi.spyOn(EmbyClient, 'logoutUserToken').mockResolvedValue();

    await logoutUserToken('jellyfin', 'http://jellyfin', 'j');
    await logoutUserToken('emby', 'http://emby', 'e');

    expect(jellyfin).toHaveBeenCalledExactlyOnceWith('http://jellyfin', 'j');
    expect(emby).toHaveBeenCalledExactlyOnceWith('http://emby', 'e');
  });
});

// ============================================================================
// Interface Compliance Tests
// ============================================================================

describe('IMediaServerClient Interface Compliance', () => {
  const createTestClient = (type: ServerType): IMediaServerClient => {
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

  it('rejects when plex.tv fails to list shared servers, since an empty list reads as nobody having access', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('busy', { status: 503 }));
    await expect(PlexClient.getSharedServerUsers('token', 'machine-1')).rejects.toThrow();
    fetchSpy.mockRestore();
  });
});

describe('JellyfinClient Static Methods', () => {
  it('should have verifyServerAdmin static method', () => {
    expect(typeof JellyfinClient.verifyServerAdmin).toBe('function');
  });
});

describe('EmbyClient Static Methods', () => {
  it('should have authenticateByName static method', () => {
    expect(typeof EmbyClient.authenticateByName).toBe('function');
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
