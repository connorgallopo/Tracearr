import { describe, it, expect } from 'vitest';
import type { Server } from '@tracearr/shared';
import { availableUpdate } from './serverVersion';

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Jellyfin',
    type: 'jellyfin',
    url: 'http://jellyfin.local:8096',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

describe('availableUpdate', () => {
  it('offers nothing for a server that has not reported a version', () => {
    expect(availableUpdate(server({ latestVersion: '10.11.12' }))).toBeNull();
  });

  it('offers nothing for a server on the newest release', () => {
    expect(availableUpdate(server({ version: '10.11.11', latestVersion: '10.11.11' }))).toBeNull();
  });

  it('names the release a server could move to', () => {
    expect(availableUpdate(server({ version: '10.11.11', latestVersion: '10.11.12' }))).toBe(
      '10.11.12'
    );
  });

  it('calls a server ahead of the public feed up to date', () => {
    expect(
      availableUpdate(server({ version: '1.43.4.10903', latestVersion: '1.43.3.10896' }))
    ).toBeNull();
  });

  it('offers nothing while no release is known', () => {
    expect(availableUpdate(server({ version: '10.11.11' }))).toBeNull();
  });
});
