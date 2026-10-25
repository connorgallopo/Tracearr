import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const maintenance = vi.hoisted(() => ({ isUnreachable: false }));
vi.mock('@/hooks/useMaintenanceMode', () => ({
  useMaintenanceMode: () => maintenance,
}));

const auth = vi.hoisted(() => ({ role: 'owner' }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => ({ user: { role: auth.role } }) }));

vi.mock('./ImpersonationBanner', () => ({
  ImpersonationBanner: () => <div>impersonation</div>,
}));
vi.mock('./ServerHealthBanner', () => ({
  ServerHealthBanner: () => <div>server-health</div>,
}));
vi.mock('./IpWarningBanner', () => ({
  IpWarningBanner: () => <div>ip-warning</div>,
}));
vi.mock('./BasemapBanner', () => ({
  BasemapBanner: () => <div>basemap</div>,
}));
vi.mock('./StorageWarningBanner', () => ({
  StorageWarningBanner: () => <div>storage-warning</div>,
}));

import { StatusBanners } from './StatusBanners';

describe('StatusBanners', () => {
  beforeEach(() => {
    auth.role = 'owner';
  });

  it('shows the per-feature banners while the server answers', () => {
    maintenance.isUnreachable = false;
    render(<StatusBanners />);

    expect(screen.getByText('server-health')).toBeInTheDocument();
    expect(screen.getByText('ip-warning')).toBeInTheDocument();
    expect(screen.getByText('basemap')).toBeInTheDocument();
    expect(screen.getByText('storage-warning')).toBeInTheDocument();
    expect(screen.queryByText('maintenance.unreachable')).toBeNull();
  });

  it('hides the storage warning for an admin', () => {
    auth.role = 'admin';
    maintenance.isUnreachable = false;
    render(<StatusBanners />);

    expect(screen.getByText('ip-warning')).toBeInTheDocument();
    expect(screen.queryByText('storage-warning')).toBeNull();
  });

  it('leaves the operator banners to the owner and admins', () => {
    auth.role = 'member';
    maintenance.isUnreachable = false;
    render(<StatusBanners />);

    expect(screen.queryByText('server-health')).toBeNull();
    expect(screen.queryByText('ip-warning')).toBeNull();
    expect(screen.queryByText('basemap')).toBeNull();
  });

  it.each([false, true])('puts the viewing-as banner first when unreachable is %s', (down) => {
    maintenance.isUnreachable = down;
    const { container } = render(<StatusBanners />);

    expect(container.firstElementChild).toHaveTextContent('impersonation');
  });

  it('replaces them with the unreachable notice while it does not', () => {
    maintenance.isUnreachable = true;
    render(<StatusBanners />);

    expect(screen.getByText('maintenance.unreachable')).toBeInTheDocument();
    expect(screen.queryByText('server-health')).toBeNull();
    expect(screen.queryByText('ip-warning')).toBeNull();
    expect(screen.queryByText('basemap')).toBeNull();
  });
});
