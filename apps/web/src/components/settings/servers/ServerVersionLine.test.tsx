import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Server } from '@tracearr/shared';
import { ServerVersionLine } from './ServerVersionLine';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { version?: string }) =>
      options?.version ? `${key}:${options.version}` : key,
  }),
}));

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

describe('ServerVersionLine', () => {
  it('says nothing about a server that has not reported a version', () => {
    const { container } = render(<ServerVersionLine server={server()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('calls a server on the newest release up to date', () => {
    render(
      <ServerVersionLine server={server({ version: '10.11.11', latestVersion: '10.11.11' })} />
    );

    expect(screen.getByText(/servers\.version\.installed:10\.11\.11/)).toBeInTheDocument();
    expect(screen.getByText('servers.version.upToDate')).toBeInTheDocument();
  });

  it('names the release a server could move to', () => {
    render(
      <ServerVersionLine server={server({ version: '10.11.11', latestVersion: '10.11.12' })} />
    );

    expect(screen.getByText('servers.version.updateAvailable:10.11.12')).toBeInTheDocument();
    expect(screen.queryByText('servers.version.upToDate')).not.toBeInTheDocument();
  });

  it('shows the installed version alone while no release is known', () => {
    render(<ServerVersionLine server={server({ version: '10.11.11' })} />);

    expect(screen.getByText(/servers\.version\.installed:10\.11\.11/)).toBeInTheDocument();
    expect(screen.queryByText('servers.version.upToDate')).not.toBeInTheDocument();
  });
});
