import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RemoteAccess } from './RemoteAccess';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useSettings: vi.fn(),
  useTailscaleStatus: vi.fn(),
  useTailscaleLogs: vi.fn(() => ({ data: undefined })),
  useEnableTailscale: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useDisableTailscale: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useResetTailscale: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

vi.mock('@/hooks/useDebouncedSave', () => ({
  useDebouncedSave: vi.fn(),
  TEXT_INPUT_DELAY: 1000,
}));

import { useSettings, useTailscaleStatus } from '@/hooks/queries';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

function externalUrlField(value: string, setValue = vi.fn()) {
  return {
    value,
    setValue,
    status: 'idle',
    errorMessage: null,
    saveNow: vi.fn(),
    reset: vi.fn(),
    retry: vi.fn(),
    isDirty: false,
    hasError: false,
  } as unknown as ReturnType<typeof useDebouncedSave>;
}

describe('RemoteAccess', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSettings).mockReturnValue({
      data: { externalUrl: 'https://tracearr.example.com' },
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useDebouncedSave).mockReturnValue(externalUrlField('https://tracearr.example.com'));
    vi.mocked(useTailscaleStatus).mockReturnValue({
      data: { available: false },
      isLoading: false,
    } as unknown as ReturnType<typeof useTailscaleStatus>);
  });

  it('holds the external URL field beside a detect action', () => {
    render(<RemoteAccess />);

    expect(screen.getByLabelText('general.externalUrl')).toHaveValue(
      'https://tracearr.example.com'
    );
    expect(screen.getByRole('button', { name: 'general.detect' })).toBeInTheDocument();
  });

  it('warns about a localhost url on the warning token, not a hardcoded yellow', () => {
    vi.mocked(useDebouncedSave).mockReturnValue(externalUrlField('http://localhost:3000'));

    render(<RemoteAccess />);

    const alert = screen.getByText('general.localhostWarning').closest('[data-slot="alert"]');
    expect(alert).toHaveAttribute('data-variant', 'warning');
  });

  it('warns about a plain-http public url', () => {
    vi.mocked(useDebouncedSave).mockReturnValue(externalUrlField('http://tracearr.example.com'));

    render(<RemoteAccess />);

    expect(screen.getByText('general.iosHttpWarning')).toBeInTheDocument();
  });

  it('marks Tailscale as beta with the shared badge', () => {
    render(<RemoteAccess />);

    expect(screen.getByText('beta')).toHaveAttribute('data-variant', 'warning');
  });

  it('lists a connected tailnet as label and value pairs, never a table', () => {
    vi.mocked(useTailscaleStatus).mockReturnValue({
      data: {
        available: true,
        status: 'connected',
        tailnetName: 'example.ts.net',
        hostname: 'tracearr',
        tailnetIp: '100.64.0.1',
        dnsName: 'tracearr.example.ts.net',
        tailnetUrl: 'https://tracearr.example.ts.net',
      },
      isLoading: false,
    } as unknown as ReturnType<typeof useTailscaleStatus>);

    render(<RemoteAccess />);

    expect(screen.getByText('100.64.0.1')).toBeInTheDocument();
    expect(
      screen.getByRole('link', { name: 'https://tracearr.example.ts.net' })
    ).toBeInTheDocument();
    expect(document.querySelector('table')).toBeNull();

    const list = document.querySelector('dl');
    expect(list).toHaveClass('@md/tailnet:grid-cols-[auto_minmax(0,1fr)]');
    expect(list?.parentElement).toHaveClass('@container/tailnet');
  });

  it('offers the hostname field when Tailscale is off', async () => {
    const enable = vi.fn();
    const { useEnableTailscale } = await import('@/hooks/queries');
    vi.mocked(useEnableTailscale).mockReturnValue({
      mutate: enable,
      isPending: false,
    } as unknown as ReturnType<typeof useEnableTailscale>);
    vi.mocked(useTailscaleStatus).mockReturnValue({
      data: { available: true, status: 'disabled' },
      isLoading: false,
    } as unknown as ReturnType<typeof useTailscaleStatus>);

    render(<RemoteAccess />);
    await userEvent.type(screen.getByLabelText('tailscale.hostnameLabel'), 'homelab');
    await userEvent.click(screen.getByRole('button', { name: 'tailscale.enable' }));

    expect(enable).toHaveBeenCalledWith('homelab');
  });
});
