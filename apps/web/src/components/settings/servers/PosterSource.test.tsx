import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Server, Settings } from '@tracearr/shared';
import { PosterSource } from './PosterSource';

// jsdom has no pointer capture API, which Radix Select's trigger relies on
// when handling pointerdown/click to open the listbox.
if (typeof Element.prototype.hasPointerCapture === 'undefined') {
  Element.prototype.hasPointerCapture = () => false;
}
if (typeof Element.prototype.releasePointerCapture === 'undefined') {
  Element.prototype.releasePointerCapture = () => {
    // no-op: jsdom has no pointer capture to release
  };
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useSettings: vi.fn(),
  useServers: vi.fn(),
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));

vi.mock('@/hooks/useDebouncedSave', () => ({
  useDebouncedSave: vi.fn(),
}));

import { useServers, useSettings } from '@/hooks/queries';
import { useAuth } from '@/hooks/useAuth';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

const mockUseServers = vi.mocked(useServers);
const mockUseSettings = vi.mocked(useSettings);
const mockUseAuth = vi.mocked(useAuth);
const mockUseDebouncedSave = vi.mocked(useDebouncedSave);

function server(overrides: Partial<Server> = {}): Server {
  return {
    id: 'server-1',
    name: 'Living Room Plex',
    type: 'plex',
    url: 'http://plex.local:32400',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function settingsData(overrides: Partial<Settings> = {}): Settings {
  return { preferredPosterServerId: null, ...overrides } as Settings;
}

type DebouncedSaveReturn = ReturnType<typeof useDebouncedSave>;

function debouncedSaveResult(
  value: string | null,
  overrides: Partial<DebouncedSaveReturn> = {}
): DebouncedSaveReturn {
  return {
    value,
    setValue: vi.fn(),
    status: 'idle',
    errorMessage: null,
    saveNow: vi.fn(),
    reset: vi.fn(),
    retry: vi.fn(),
    isDirty: false,
    hasError: false,
    ...overrides,
  };
}

describe('PosterSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServers.mockReturnValue({
      data: [server()],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    mockUseAuth.mockReturnValue({
      user: { role: 'owner' },
    } as unknown as ReturnType<typeof useAuth>);
  });

  it('tells a non-owner the control is owner-only, even with servers present', () => {
    mockUseAuth.mockReturnValue({
      user: { role: 'admin' },
    } as unknown as ReturnType<typeof useAuth>);
    mockUseSettings.mockReturnValue({
      data: settingsData(),
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    mockUseDebouncedSave.mockReturnValue(debouncedSaveResult(null));

    render(<PosterSource />);

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('servers.posterSource.ownerOnly');
  });

  it('shows a skeleton while settings are loading', () => {
    mockUseSettings.mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useSettings>);
    mockUseDebouncedSave.mockReturnValue(debouncedSaveResult(null));

    render(<PosterSource />);
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('disables the control and shows a helper hint when there are no servers', () => {
    mockUseServers.mockReturnValue({
      data: [],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    mockUseSettings.mockReturnValue({
      data: settingsData(),
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    mockUseDebouncedSave.mockReturnValue(debouncedSaveResult(null));

    render(<PosterSource />);
    expect(screen.getByRole('combobox')).toBeDisabled();
    expect(screen.getByText('servers.posterSource.emptyHint')).toBeInTheDocument();
  });

  it('reflects the currently saved preference and offers Automatic plus every server', async () => {
    const serverA = server({ id: 'server-a', name: 'Plex Server' });
    const serverB = server({ id: 'server-b', name: 'Jellyfin Server' });
    mockUseServers.mockReturnValue({
      data: [serverA, serverB],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    mockUseSettings.mockReturnValue({
      data: settingsData({ preferredPosterServerId: 'server-a' }),
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    mockUseDebouncedSave.mockReturnValue(debouncedSaveResult('server-a'));

    render(<PosterSource />);

    expect(screen.getByRole('combobox')).toHaveTextContent('Plex Server');

    await userEvent.click(screen.getByRole('combobox'));
    expect(
      screen.getByRole('option', { name: 'servers.posterSource.automatic' })
    ).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Plex Server' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Jellyfin Server' })).toBeInTheDocument();
  });

  it('saves null when switching back to Automatic', async () => {
    const serverA = server({ id: 'server-a', name: 'Plex Server' });
    const setValue = vi.fn();
    mockUseServers.mockReturnValue({
      data: [serverA],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    mockUseSettings.mockReturnValue({
      data: settingsData({ preferredPosterServerId: 'server-a' }),
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    mockUseDebouncedSave.mockReturnValue(debouncedSaveResult('server-a', { setValue }));

    render(<PosterSource />);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'servers.posterSource.automatic' }));

    expect(setValue).toHaveBeenCalledWith(null);
  });

  it('saves the chosen server id when picking a specific server', async () => {
    const serverA = server({ id: 'server-a', name: 'Plex Server' });
    const serverB = server({ id: 'server-b', name: 'Jellyfin Server' });
    const setValue = vi.fn();
    mockUseServers.mockReturnValue({
      data: [serverA, serverB],
      isLoading: false,
    } as unknown as ReturnType<typeof useServers>);
    mockUseSettings.mockReturnValue({
      data: settingsData({ preferredPosterServerId: null }),
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    mockUseDebouncedSave.mockReturnValue(debouncedSaveResult(null, { setValue }));

    render(<PosterSource />);

    await userEvent.click(screen.getByRole('combobox'));
    await userEvent.click(screen.getByRole('option', { name: 'Jellyfin Server' }));

    expect(setValue).toHaveBeenCalledWith('server-b');
  });
});
