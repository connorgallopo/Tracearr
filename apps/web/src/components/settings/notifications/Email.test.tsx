import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Email } from './Email';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('./BrandingForm', () => ({ BrandingForm: () => <div>branding form</div> }));
vi.mock('./Suppressions', () => ({ Suppressions: () => <div>suppressions</div> }));
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));
import { useAuth } from '@/hooks/useAuth';

function renderAs(role: string) {
  vi.mocked(useAuth).mockReturnValue({ user: { role } } as unknown as ReturnType<typeof useAuth>);
  return render(<Email />);
}

describe('Email section', () => {
  it('shows both cards to the owner under the section header', () => {
    renderAs('owner');
    expect(
      screen.getByRole('heading', { level: 2, name: 'nav.sections.email' })
    ).toBeInTheDocument();
    expect(screen.getByText('branding form')).toBeInTheDocument();
    expect(screen.getByText('suppressions')).toBeInTheDocument();
  });

  it('tells an admin the page is owner-only', () => {
    renderAs('admin');
    expect(screen.getByRole('alert')).toHaveTextContent('email.ownerOnly');
    expect(screen.queryByText('branding form')).not.toBeInTheDocument();
  });
});
