import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MobileSession } from '@tracearr/shared';
import { MobileDeviceRow } from './MobileDeviceRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

vi.mock('@/hooks/queries', () => ({
  useRevokeSession: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
  useUpdateMobileSession: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
}));

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
  it('titles the row with the device name and badges its platform', () => {
    render(<MobileDeviceRow session={session()} />);

    expect(screen.getByText("Alice's iPhone")).toBeInTheDocument();
    expect(screen.getByText('iOS')).toBeInTheDocument();
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
});
