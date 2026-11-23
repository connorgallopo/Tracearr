import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PairingCode } from './PairingCode';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

const code = {
  userCode: '1234-5678',
  link: 'https://media.example.com/silo/activate?code=12345678',
  waiting: true,
  opened: false,
  expired: false,
  onRequestNew: vi.fn(),
};

describe('PairingCode', () => {
  it('shows and copies the code as two groups of four, as Silo shows it', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<PairingCode {...code} />);

    expect(screen.getByText('1234 5678')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'pages:login.member.copyCode' }));
    await expect(navigator.clipboard.readText()).resolves.toBe('1234 5678');

    rerender(<PairingCode {...code} userCode="12345678" />);
    expect(screen.getByText('1234 5678')).toBeInTheDocument();
  });

  it('opens Silo in a new tab and says where the code is entered, under its path prefix', () => {
    render(<PairingCode {...code} />);

    const open = screen.getByRole('link', { name: 'settings:servers.pairing.openSilo' });
    expect(open).toHaveAttribute('href', code.link);
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noreferrer');
    expect(
      screen.getByText(
        'settings:servers.pairing.enterAt:{"address":"https://media.example.com/silo/activate"}'
      )
    ).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('pages:login.member.waiting');
  });

  it('hides a lapsed code and offers a new one', async () => {
    const onRequestNew = vi.fn();
    render(<PairingCode {...code} expired onRequestNew={onRequestNew} />);

    expect(screen.queryByText('1234 5678')).toBeNull();
    expect(screen.getByText('pages:login.member.codeExpired')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'settings:servers.pairing.newCode' }));
    expect(onRequestNew).toHaveBeenCalled();
  });
});
