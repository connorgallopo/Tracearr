import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Destinations } from './Destinations';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/settings/destinations', () => ({
  DestinationsManager: () => <div>destinations manager</div>,
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));

import { useAuth } from '@/hooks/useAuth';

function renderAs(role: string) {
  vi.mocked(useAuth).mockReturnValue({
    user: { role },
  } as unknown as ReturnType<typeof useAuth>);
  return render(<Destinations />);
}

describe('Destinations section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gives the owner the destinations manager', () => {
    renderAs('owner');

    expect(screen.getByText('destinations manager')).toBeInTheDocument();
  });

  it('tells an admin the list is owner-only instead of showing an empty manager', () => {
    renderAs('admin');

    expect(screen.queryByText('destinations manager')).not.toBeInTheDocument();
    expect(screen.getByText('pages:settings.destinations.ownerOnly')).toBeInTheDocument();
  });

  it('states the owner-only rule as a notice rather than loose text', () => {
    renderAs('admin');

    expect(screen.getByRole('alert')).toHaveTextContent('pages:settings.destinations.ownerOnly');
  });
});
