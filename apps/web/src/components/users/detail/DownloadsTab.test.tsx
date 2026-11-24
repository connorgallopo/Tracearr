import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { DownloadsTab } from './DownloadsTab';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useServer', () => ({ useServer: () => ({ selectedServers: [] }) }));
vi.mock('@/hooks/queries', () => ({ useUserDownloads: vi.fn() }));

import { useUserDownloads } from '@/hooks/queries';

const download = {
  id: 'd-1',
  serverId: 'server-1',
  serverName: 'Server One',
  serverUserId: 'su-1',
  username: 'alice',
  identityName: null,
  title: 'The Movie',
  mediaId: null,
  requestCount: 1,
  firstSeenAt: '2026-10-19T10:00:00.000Z',
  lastSeenAt: '2026-10-19T10:00:00.000Z',
  fileSizeBytes: 1024,
  deliveredBytes: null,
  deliveredBitrateKbps: null,
  isLocal: true,
};

function mockDownloads(rows: object[], total: number) {
  vi.mocked(useUserDownloads).mockReturnValue({
    data: { data: rows, total },
    isLoading: false,
  } as unknown as ReturnType<typeof useUserDownloads>);
}

describe('DownloadsTab', () => {
  it('lists the downloads without a user column and pages ten at a time', async () => {
    mockDownloads([download], 25);

    render(
      <MemoryRouter>
        <DownloadsTab userId="su-1" scope="identity" showServer={false} />
      </MemoryRouter>
    );

    expect(screen.getByText('The Movie')).toBeInTheDocument();
    expect(screen.queryByText('labels.user')).not.toBeInTheDocument();
    expect(screen.queryByText('labels.profile')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'actions.next' }));

    expect(vi.mocked(useUserDownloads)).toHaveBeenLastCalledWith('su-1', {
      page: 2,
      pageSize: 10,
      scope: 'identity',
    });
  });

  it("names a download's non-main profile in a Profile column", () => {
    mockDownloads(
      [{ ...download, nonMainProfile: { name: 'Kids', thumbUrl: null, removed: false } }],
      1
    );

    render(
      <MemoryRouter>
        <DownloadsTab userId="su-1" scope="identity" showServer={false} />
      </MemoryRouter>
    );

    expect(screen.getByRole('columnheader', { name: 'labels.profile' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'Kids' })).toBeInTheDocument();
  });
});
