import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { format, formatDistanceToNow } from 'date-fns';
import type { MobileSession } from '@tracearr/shared';
import { MobileDeviceRow } from './MobileDeviceRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useRevokeSession: vi.fn(),
  useUpdateMobileSession: vi.fn(),
}));

import { useRevokeSession, useUpdateMobileSession } from '@/hooks/queries';

function session(overrides: Partial<MobileSession> = {}): MobileSession {
  return {
    id: 'session-1',
    deviceName: "Alice's iPhone",
    platform: 'ios',
    lastSeenAt: '2026-09-01T00:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  } as MobileSession;
}

describe('MobileDeviceRow', () => {
  const revokeMutate = vi.fn();
  const updateMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useRevokeSession).mockReturnValue({
      mutate: revokeMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useRevokeSession>);
    vi.mocked(useUpdateMobileSession).mockReturnValue({
      mutate: updateMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useUpdateMobileSession>);
  });

  it('titles the row with the device name and badges its platform', () => {
    render(<MobileDeviceRow session={session()} />);

    expect(screen.getByText("Alice's iPhone")).toBeInTheDocument();
    expect(screen.getByText('iOS')).toBeInTheDocument();
  });

  it('renders the last-seen and connected-on meta text', () => {
    const s = session();
    render(<MobileDeviceRow session={s} />);

    const when = formatDistanceToNow(new Date(s.lastSeenAt), { addSuffix: true });
    const date = format(new Date(s.createdAt), 'MMM d, yyyy');

    expect(screen.getByText(`mobile.lastSeen:${JSON.stringify({ when })}`)).toBeInTheDocument();
    expect(screen.getByText(`mobile.connectedOn:${JSON.stringify({ date })}`)).toBeInTheDocument();
  });

  it('names the rename and revoke actions', () => {
    render(<MobileDeviceRow session={session()} />);

    expect(screen.getByRole('button', { name: 'mobile.renameDevice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'mobile.removeDevice' })).toBeInTheDocument();
  });

  it('opens the rename dialog seeded with the current name', async () => {
    render(<MobileDeviceRow session={session()} />);

    await userEvent.click(screen.getByRole('button', { name: 'mobile.renameDevice' }));

    expect(screen.getByLabelText('mobile.deviceName')).toHaveValue("Alice's iPhone");
  });

  it('asks before revoking, naming the device in the question', async () => {
    render(<MobileDeviceRow session={session()} />);

    await userEvent.click(screen.getByRole('button', { name: 'mobile.removeDevice' }));

    expect(
      screen.getByText('mobile.removeDeviceConfirm:{"deviceName":"Alice\'s iPhone"}')
    ).toBeInTheDocument();
  });

  it('revokes the device by id once the confirm dialog is accepted', async () => {
    render(<MobileDeviceRow session={session({ id: 'session-42' })} />);

    await userEvent.click(screen.getByRole('button', { name: 'mobile.removeDevice' }));
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.remove' }));

    expect(revokeMutate).toHaveBeenCalledWith('session-42');
  });
});
