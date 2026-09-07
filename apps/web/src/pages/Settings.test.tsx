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
vi.mock('@/components/settings/general/Appearance', () => ({
  Appearance: () => <div>appearance settings</div>,
}));
vi.mock('@/components/settings/general/Locale', () => ({
  Locale: () => <div>locale settings</div>,
}));
vi.mock('@/components/settings/general/Behavior', () => ({
  Behavior: () => <div>behavior settings</div>,
}));
vi.mock('@/components/settings/data/Api', () => ({
  Api: () => <div>api settings</div>,
}));
vi.mock('@/components/settings/servers/Connections', () => ({
  Connections: () => <div>connections</div>,
}));
vi.mock('@/components/settings/servers/PosterSource', () => ({
  PosterSource: () => <div>poster source</div>,
}));
vi.mock('@/components/settings/servers/PlexAccounts', () => ({
  PlexAccounts: () => <div>plex accounts</div>,
}));
vi.mock('@/components/settings/access/Guest', () => ({
  Guest: () => <div>access settings</div>,
}));
vi.mock('@/components/settings/access/MobileDevices', () => ({
  MobileDevices: () => <div>mobile settings</div>,
}));
vi.mock('@/components/settings/access/RemoteAccess', () => ({
  RemoteAccess: () => <div>remote access settings</div>,
}));
vi.mock('@/components/settings/data/Import', () => ({
  Import: () => <div>import settings</div>,
}));
vi.mock('@/components/settings/data/Jobs', () => ({
  Jobs: () => <div>jobs settings</div>,
}));
vi.mock('@/components/settings/data/Backup', () => ({
  Backup: () => <div>backup settings</div>,
}));
vi.mock('@/components/settings/notifications/Destinations', () => ({
  Destinations: () => <div>destinations</div>,
}));
vi.mock('@/components/settings/notifications/Email', () => ({
  Email: () => <div>email settings</div>,
}));
vi.mock('@/components/settings/notifications/Newsletters', () => ({
  Newsletters: () => <div>newsletters</div>,
}));
vi.mock('@/components/settings/notifications/newsletter/NewsletterEditor', () => ({
  NewsletterEditor: () => <div>newsletter editor</div>,
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
    ['/settings/general', '/settings/general/appearance'],
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
    ['/settings/general/appearance', 'appearance settings'],
    ['/settings/general/locale', 'locale settings'],
    ['/settings/general/behavior', 'behavior settings'],
    ['/settings/data/api', 'api settings'],
    ['/settings/servers/connections', 'connections'],
    ['/settings/servers/posters', 'poster source'],
    ['/settings/servers/plex-accounts', 'plex accounts'],
    ['/settings/notifications/destinations', 'destinations'],
    ['/settings/notifications/email', 'email settings'],
    ['/settings/notifications/newsletters', 'newsletters'],
    ['/settings/notifications/newsletters/new', 'newsletter editor'],
    ['/settings/notifications/newsletters/n-1', 'newsletter editor'],
    ['/settings/access/guest', 'access settings'],
    ['/settings/access/mobile', 'mobile settings'],
    ['/settings/access/remote', 'remote access settings'],
    ['/settings/data/import', 'import settings'],
    ['/settings/data/backup', 'backup settings'],
    ['/settings/data/jobs', 'jobs settings'],
  ])('renders %s', (path, content) => {
    renderAt(path);

    expect(screen.getByText(content)).toBeInTheDocument();
  });
});
