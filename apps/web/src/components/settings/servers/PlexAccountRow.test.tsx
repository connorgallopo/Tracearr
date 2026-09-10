import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PlexAccountRow } from './PlexAccountRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

function account(overrides = {}) {
  return {
    id: 'account-1',
    plexUsername: 'alice',
    plexEmail: 'alice@example.com',
    plexThumbnail: null,
    allowLogin: true,
    serverCount: 0,
    ...overrides,
  };
}

function renderRow(overrides = {}) {
  return render(
    <PlexAccountRow
      account={account() as React.ComponentProps<typeof PlexAccountRow>['account']}
      onUnlink={vi.fn()}
      onReauthorize={vi.fn()}
      isReauthorizing={false}
      oauthBusy={false}
      {...overrides}
    />
  );
}

describe('PlexAccountRow', () => {
  it('titles the row with the username and counts its servers', () => {
    renderRow();

    expect(screen.getByText('alice')).toBeInTheDocument();
    expect(
      screen.getByText('pages:settings.plex.serversConnected:{"count":0}')
    ).toBeInTheDocument();
  });

  it('names both icon-only actions', () => {
    renderRow();

    expect(
      screen.getByRole('button', { name: 'pages:settings.plex.reauthorizeAccount' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'pages:settings.plex.unlinkAccount' })
    ).toBeInTheDocument();
  });

  it('blocks unlinking while servers still use the account', () => {
    renderRow({
      account: account({ serverCount: 2 }) as React.ComponentProps<
        typeof PlexAccountRow
      >['account'],
    });

    expect(
      screen.getByRole('button', { name: 'pages:settings.plex.unlinkAccount' })
    ).toBeDisabled();
  });
});
