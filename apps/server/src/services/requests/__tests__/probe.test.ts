import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockClient, mockFindServerByMachineId } = vi.hoisted(() => ({
  mockClient: {
    status: vi.fn(),
    mainSettings: vi.fn(),
    plexSettings: vi.fn(),
    jellyfinSettings: vi.fn(),
  },
  mockFindServerByMachineId: vi.fn(),
}));

vi.mock('../seerrClient.js', () => ({
  SeerrClient: vi.fn(function SeerrClient() {
    return mockClient;
  }),
}));
vi.mock('../../../db/client.js', () => ({ db: {} }));
vi.mock('../serverLookup.js', () => ({ findServerByMachineId: mockFindServerByMachineId }));

import { probeSeerr, SeerrProbeError } from '../probe.js';

describe('probeSeerr', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockClient.status.mockResolvedValue({ version: 'develop-4fc2' });
    mockFindServerByMachineId.mockResolvedValue(null);
  });

  it('reads the plex machine id for a plex-backed instance', async () => {
    mockClient.mainSettings.mockResolvedValue({ applicationTitle: 'Beckon', mediaServerType: 1 });
    mockClient.plexSettings.mockResolvedValue({ name: 'GMS', machineId: 'abc123' });
    mockFindServerByMachineId.mockResolvedValue({ id: 'srv-1' });

    const result = await probeSeerr('http://seerr.local:5055', 'k');
    expect(result).toEqual({
      applicationTitle: 'Beckon',
      version: 'develop-4fc2',
      mediaServerType: 'plex',
      remoteServerId: 'abc123',
      matchedServerId: 'srv-1',
    });
    expect(mockClient.jellyfinSettings).not.toHaveBeenCalled();
  });

  it('reads the jellyfin server id for jellyfin and emby instances', async () => {
    mockClient.mainSettings.mockResolvedValue({ applicationTitle: 'JS', mediaServerType: 3 });
    mockClient.jellyfinSettings.mockResolvedValue({ name: 'Emby', serverId: 'emby-9' });
    const result = await probeSeerr('http://seerr.local:5055', 'k');
    expect(result.mediaServerType).toBe('emby');
    expect(result.remoteServerId).toBe('emby-9');
    expect(result.matchedServerId).toBeNull();
  });

  it('fails plainly when seerr has no media server configured', async () => {
    mockClient.mainSettings.mockResolvedValue({ applicationTitle: 'X', mediaServerType: 4 });
    await expect(probeSeerr('http://seerr.local:5055', 'k')).rejects.toBeInstanceOf(
      SeerrProbeError
    );
  });
});
