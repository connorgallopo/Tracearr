import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDb, rows } = vi.hoisted(() => {
  const rows = vi.fn();
  return {
    rows,
    mockDb: { select: vi.fn(() => ({ from: () => ({ where: () => ({ limit: rows }) }) })) },
  };
});

vi.mock('../../../db/client.js', () => ({ db: mockDb }));

import { findServerById, findServerByMachineId, serverTypeById } from '../serverLookup.js';

describe('Seerr server eligibility', () => {
  beforeEach(() => vi.clearAllMocks());

  it('excludes Dispatcharr from matching, linking, and request resolution', async () => {
    rows.mockResolvedValue([
      { id: 'tv', name: 'TV', machineIdentifier: 'shared-machine', type: 'dispatcharr' },
    ]);

    expect(await findServerByMachineId('shared-machine')).toBeNull();
    expect(await findServerById('tv')).toBeNull();
    expect(await serverTypeById('tv')).toBeNull();
  });

  it.each(['plex', 'jellyfin', 'emby'])('retains %s matching and linking', async (type) => {
    const server = { id: 'media', name: 'Media', machineIdentifier: 'machine', type };
    rows.mockResolvedValue([server]);

    expect(await findServerByMachineId('machine')).toEqual({ id: server.id, type });
    expect(await findServerById('media')).toEqual(server);
    expect(await serverTypeById('media')).toBe(type);
  });

  it('returns no match for a missing server', async () => {
    rows.mockResolvedValue([]);

    expect(await findServerByMachineId('missing')).toBeNull();
    expect(await findServerById('missing')).toBeNull();
    expect(await serverTypeById('missing')).toBeNull();
  });
});
