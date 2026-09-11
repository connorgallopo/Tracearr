import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RequestService, RequestServiceProbeResult, Server } from '@tracearr/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useServers: vi.fn(),
  useCreateRequestService: vi.fn(),
  useUpdateRequestService: vi.fn(),
  useTestRequestService: vi.fn(),
}));

import {
  useServers,
  useCreateRequestService,
  useUpdateRequestService,
  useTestRequestService,
} from '@/hooks/queries';
import { LinkDialog } from './LinkDialog';

const servers = [
  { id: 'srv-1', name: 'Plex', type: 'plex', machineIdentifier: 'local-abc' },
  { id: 'srv-2', name: 'Jellyfin', type: 'jellyfin', machineIdentifier: 'local-def' },
] as unknown as Server[];

const existing: RequestService = {
  id: 'rs-1',
  serverId: 'srv-1',
  type: 'seerr',
  name: 'Overseerr',
  url: 'https://seerr.example.com',
  enabled: true,
  configStatus: 'ok',
  remoteServerId: 'remote-abc',
  version: '1.33.2',
  lastSyncAt: null,
  lastFullSyncAt: null,
  lastSyncError: null,
  counts: { requests: 0, unmatchedMedia: 0, unmatchedUsers: 0 },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

function probe(overrides: Partial<RequestServiceProbeResult> = {}): RequestServiceProbeResult {
  return {
    applicationTitle: 'Overseerr',
    version: '1.33.2',
    mediaServerType: 'plex',
    remoteServerId: 'remote-abc',
    matchedServerId: 'srv-1',
    ...overrides,
  };
}

const createMutate = vi.fn();
const updateMutate = vi.fn();

/** Resolves the test call synchronously with whatever the case queued up. */
function mockTest(result: RequestServiceProbeResult | Error) {
  vi.mocked(useTestRequestService).mockReturnValue({
    mutate: (
      _input: unknown,
      opts?: {
        onSuccess?: (value: RequestServiceProbeResult) => void;
        onError?: (error: Error) => void;
      }
    ) => {
      if (result instanceof Error) opts?.onError?.(result);
      else opts?.onSuccess?.(result);
    },
    isPending: false,
  } as unknown as ReturnType<typeof useTestRequestService>);
}

function renderDialog(props: Partial<React.ComponentProps<typeof LinkDialog>> = {}) {
  const first = servers[0]!;
  return render(<LinkDialog open onOpenChange={vi.fn()} server={first} {...props} />);
}

describe('LinkDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useServers).mockReturnValue({
      data: servers,
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    vi.mocked(useCreateRequestService).mockReturnValue({
      mutate: createMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useCreateRequestService>);
    vi.mocked(useUpdateRequestService).mockReturnValue({
      mutate: updateMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateRequestService>);
    mockTest(probe());
  });

  it('keeps save disabled until a test matches this very server', async () => {
    const user = userEvent.setup();
    renderDialog();

    const save = screen.getByRole('button', { name: 'requests.dialog.save' });
    expect(save).toBeDisabled();
    expect(screen.getByText('requests.dialog.saveHint')).toBeInTheDocument();

    await user.type(screen.getByLabelText('requests.dialog.url'), 'https://seerr.example.com');
    await user.type(screen.getByLabelText('requests.dialog.apiKey'), 'key-1');
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'requests.dialog.test' }));
    expect(save).toBeEnabled();
    expect(screen.queryByText('requests.dialog.saveHint')).not.toBeInTheDocument();

    await user.type(screen.getByLabelText('requests.dialog.url'), '/extra');
    expect(save).toBeDisabled();
  });

  it('sits the test button in the api key field rather than the footer', () => {
    renderDialog();

    const test = screen.getByRole('button', { name: 'requests.dialog.test' });
    expect(test.closest('[data-slot=dialog-footer]')).toBeNull();
    expect(test.closest('[data-slot=input-group]')).toContainElement(
      screen.getByLabelText('requests.dialog.apiKey')
    );
  });

  it('announces the test result and points both fields at it', () => {
    renderDialog();

    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('id', 'request-service-test-result');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(screen.getByLabelText('requests.dialog.url')).toHaveAttribute(
      'aria-describedby',
      'request-service-test-result'
    );
    expect(screen.getByLabelText('requests.dialog.apiKey')).toHaveAttribute(
      'aria-describedby',
      'request-service-test-result'
    );
  });

  it('creates the link with the tested url and key', async () => {
    const user = userEvent.setup();
    renderDialog();

    await user.type(screen.getByLabelText('requests.dialog.url'), 'https://seerr.example.com');
    await user.type(screen.getByLabelText('requests.dialog.apiKey'), 'key-1');
    await user.click(screen.getByRole('button', { name: 'requests.dialog.test' }));
    await user.click(screen.getByRole('button', { name: 'requests.dialog.save' }));

    expect(createMutate).toHaveBeenCalledWith(
      { serverId: 'srv-1', url: 'https://seerr.example.com', apiKey: 'key-1' },
      expect.anything()
    );
  });

  it('leads the mismatch alert with the server it does match and demotes the ids', async () => {
    const user = userEvent.setup();
    mockTest(probe({ matchedServerId: 'srv-2', remoteServerId: 'remote-zzz' }));
    renderDialog();

    await user.type(screen.getByLabelText('requests.dialog.url'), 'https://seerr.example.com');
    await user.type(screen.getByLabelText('requests.dialog.apiKey'), 'key-1');
    await user.click(screen.getByRole('button', { name: 'requests.dialog.test' }));

    const alert = screen.getByRole('alert');
    expect(
      within(alert).getByText('requests.dialog.mismatchOther:{"other":"Jellyfin"}')
    ).toBeInTheDocument();
    expect(alert).toHaveTextContent(/remote-zzz/);
    expect(alert).toHaveTextContent(/local-abc/);
    expect(screen.getByRole('button', { name: 'requests.dialog.save' })).toBeDisabled();
  });

  it('shows a failed test plainly', async () => {
    const user = userEvent.setup();
    mockTest(new Error('connect ECONNREFUSED'));
    renderDialog();

    await user.type(screen.getByLabelText('requests.dialog.url'), 'https://seerr.example.com');
    await user.type(screen.getByLabelText('requests.dialog.apiKey'), 'key-1');
    await user.click(screen.getByRole('button', { name: 'requests.dialog.test' }));

    expect(screen.getByText('connect ECONNREFUSED')).toBeInTheDocument();
  });

  it('keeps the stored key when the edit leaves the key field blank', async () => {
    const user = userEvent.setup();
    renderDialog({ existing });

    const url = screen.getByLabelText('requests.dialog.url');
    expect(url).toHaveValue('https://seerr.example.com');

    await user.clear(url);
    await user.type(url, 'https://seerr.internal');
    await user.click(screen.getByRole('button', { name: 'requests.dialog.save' }));

    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'rs-1', data: { url: 'https://seerr.internal' } },
      expect.anything()
    );
  });

  it('makes an edit that carries a new key prove itself first', async () => {
    const user = userEvent.setup();
    renderDialog({ existing });

    await user.type(screen.getByLabelText('requests.dialog.apiKey'), 'key-2');
    const save = screen.getByRole('button', { name: 'requests.dialog.save' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'requests.dialog.test' }));
    expect(save).toBeEnabled();

    await user.click(save);
    expect(updateMutate).toHaveBeenCalledWith(
      { id: 'rs-1', data: { url: 'https://seerr.example.com', apiKey: 'key-2' } },
      expect.anything()
    );
  });
});
