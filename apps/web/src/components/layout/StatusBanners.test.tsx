import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const maintenance = vi.hoisted(() => ({ isUnreachable: false }));
vi.mock('@/hooks/useMaintenanceMode', () => ({
  useMaintenanceMode: () => maintenance,
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

import { StatusBanners } from './StatusBanners';

describe('StatusBanners', () => {
  it('shows the per-feature banners while the server answers', () => {
    maintenance.isUnreachable = false;
    render(<StatusBanners />);

    expect(screen.getByText('server-health')).toBeInTheDocument();
    expect(screen.getByText('ip-warning')).toBeInTheDocument();
    expect(screen.getByText('basemap')).toBeInTheDocument();
    expect(screen.queryByText('maintenance.unreachable')).toBeNull();
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
