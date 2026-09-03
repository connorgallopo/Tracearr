import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { Settings } from './Settings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/settings/shell/SettingsNav', () => ({
  SettingsNav: () => <nav aria-label="settings nav" />,
}));
vi.mock('@/components/settings/GeneralSettings', () => ({
  GeneralSettings: () => <div>general settings</div>,
}));
vi.mock('@/components/settings/ServerSettings', () => ({
  ServerSettings: () => <div>server settings</div>,
}));
vi.mock('@/components/settings/AccessSettings', () => ({
  AccessSettings: () => <div>access settings</div>,
}));
vi.mock('@/components/settings/MobileSettings', () => ({
  MobileSettings: () => <div>mobile settings</div>,
}));
vi.mock('@/components/settings/TailscaleSettings', () => ({
  TailscaleSettings: () => <div>tailscale settings</div>,
}));
vi.mock('@/components/settings/ImportSettings', () => ({
  ImportSettings: () => <div>import settings</div>,
}));
vi.mock('@/components/settings/JobsSettings', () => ({
  JobsSettings: () => <div>jobs settings</div>,
}));
vi.mock('@/components/settings/BackupSettings', () => ({
  BackupSettings: () => <div>backup settings</div>,
}));
vi.mock('@/components/settings/notifications/Destinations', () => ({
  Destinations: () => <div>destinations</div>,
}));

function CurrentPath() {
  const { pathname } = useLocation();
  return <span data-testid="pathname">{pathname}</span>;
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route
          path="/settings/*"
          element={
            <>
              <Settings />
              <CurrentPath />
            </>
          }
        />
      </Routes>
    </MemoryRouter>
  );
}

describe('Settings routes', () => {
  it.each([
    ['/settings', '/settings/general/appearance'],
    ['/settings/servers', '/settings/servers/connections'],
    ['/settings/notifications', '/settings/notifications/destinations'],
    ['/settings/access', '/settings/access/guest'],
    ['/settings/mobile', '/settings/access/mobile'],
    ['/settings/tailscale', '/settings/access/remote'],
    ['/settings/import', '/settings/data/import'],
    ['/settings/jobs', '/settings/data/jobs'],
    ['/settings/backup', '/settings/data/backup'],
  ])('redirects %s to %s', (from, to) => {
    renderAt(from);

    expect(screen.getByTestId('pathname')).toHaveTextContent(to);
  });

  it.each([
    ['/settings/general/appearance', 'general settings'],
    ['/settings/general/locale', 'general settings'],
    ['/settings/general/behavior', 'general settings'],
    ['/settings/data/api', 'general settings'],
    ['/settings/servers/connections', 'server settings'],
    ['/settings/servers/posters', 'server settings'],
    ['/settings/servers/plex-accounts', 'server settings'],
    ['/settings/notifications/destinations', 'destinations'],
    ['/settings/access/guest', 'access settings'],
    ['/settings/access/mobile', 'mobile settings'],
    ['/settings/access/remote', 'tailscale settings'],
    ['/settings/data/import', 'import settings'],
    ['/settings/data/backup', 'backup settings'],
    ['/settings/data/jobs', 'jobs settings'],
  ])('renders %s', (path, content) => {
    renderAt(path);

    expect(screen.getByText(content)).toBeInTheDocument();
  });

  it('lays the nav beside a container-query-capped content column', () => {
    renderAt('/settings/general/appearance');

    const content = screen.getByText('general settings').parentElement;
    expect(content).toHaveClass('min-w-0', 'max-w-4xl');
    expect(content?.parentElement).toHaveClass('@3xl/settings:grid-cols-[13rem_minmax(0,1fr)]');
  });
});
