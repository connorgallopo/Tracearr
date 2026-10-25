import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { initI18n } from '@tracearr/translations';
import type { StorageMountIssue, StorageWarning } from '@tracearr/shared';
import { StorageWarningBanner } from './StorageWarningBanner';

const api = vi.hoisted(() => ({
  getStorageWarning: vi.fn(),
  dismissStorageWarning: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ api: { settings: api } }));

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const postgresIssue: StorageMountIssue = {
  key: 'postgres',
  fsType: 'fuse.shfs',
  currentPath: '/mnt/user/appdata/tracearr/postgres',
  placement: { kind: 'pool', pool: 'cache', newPath: '/mnt/cache/appdata/tracearr/postgres' },
};

function warning(overrides: Partial<StorageWarning> = {}): StorageWarning {
  return {
    applicable: true,
    issues: [postgresIssue],
    bootId: 'boot-1',
    dismissed: false,
    ...overrides,
  };
}

function renderBanner() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <StorageWarningBanner />
    </QueryClientProvider>
  );
  return { ...view, client };
}

describe('StorageWarningBanner', () => {
  beforeEach(() => {
    api.getStorageWarning.mockReset();
    api.dismissStorageWarning.mockReset();
  });

  it('shows the banner for an owner with an issue', async () => {
    api.getStorageWarning.mockResolvedValue(warning());
    renderBanner();

    expect(
      await screen.findByText(
        "Tracearr's database is on an Unraid user share, which slows every read and write."
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show me how to fix it' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Hide until Tracearr restarts' })
    ).toBeInTheDocument();
  });

  it.each([
    ['dismissed', warning({ dismissed: true })],
    ['not applicable', warning({ applicable: false, issues: [] })],
    ['no issues', warning({ issues: [] })],
  ])('hides when %s', async (_, data) => {
    api.getStorageWarning.mockResolvedValue(data);
    const { container, client } = renderBanner();

    await waitFor(() => expect(client.getQueryState(['storage-warning'])?.status).toBe('success'));
    expect(container).toBeEmptyDOMElement();
  });

  it('does not call it the database when only Redis is affected', async () => {
    api.getStorageWarning.mockResolvedValue(
      warning({
        issues: [
          {
            key: 'redis',
            fsType: 'fuse.shfs',
            currentPath: '/mnt/user/appdata/tracearr/redis',
            placement: { kind: 'unknown' },
          },
        ],
      })
    );
    renderBanner();

    expect(
      await screen.findByText(
        "Some of Tracearr's data is on an Unraid user share, which slows every read and write."
      )
    ).toBeInTheDocument();
  });

  it('refetches on reconnect and clears once the install is fixed', async () => {
    api.getStorageWarning
      .mockResolvedValueOnce(warning())
      .mockResolvedValue(warning({ issues: [] }));
    const { container } = renderBanner();
    await screen.findByRole('button', { name: 'Show me how to fix it' });

    act(() => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });

    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(api.getStorageWarning).toHaveBeenCalledTimes(2);
  });

  it('close calls dismiss and hides', async () => {
    api.getStorageWarning.mockResolvedValue(warning());
    api.dismissStorageWarning.mockResolvedValue(undefined);
    const { container } = renderBanner();

    await userEvent.click(
      await screen.findByRole('button', { name: 'Hide until Tracearr restarts' })
    );

    expect(api.dismissStorageWarning).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('opens the steps', async () => {
    api.getStorageWarning.mockResolvedValue(warning());
    renderBanner();

    await userEvent.click(await screen.findByRole('button', { name: 'Show me how to fix it' }));

    expect(screen.getByRole('dialog')).toHaveTextContent('Move the database off the user share');
  });
});
