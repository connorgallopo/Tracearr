import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ContactEmailLine } from './ContactEmailLine';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('ContactEmailLine', () => {
  it('renders the contact email under the newsletter-address label with the no-login note', () => {
    render(<ContactEmailLine contactEmail="ann@example.com" isOwner onEdit={vi.fn()} />);

    expect(screen.getByText('userDetail.contactEmailLabel ann@example.com')).toBeInTheDocument();
    expect(screen.getByText('userDetail.contactEmailNoLogin')).toBeInTheDocument();
  });

  it('shows the none-set fallback when the contact email is null', () => {
    render(<ContactEmailLine contactEmail={null} isOwner onEdit={vi.fn()} />);

    expect(
      screen.getByText('userDetail.contactEmailLabel userDetail.contactEmailNone')
    ).toBeInTheDocument();
  });

  it('hides the edit pencil for a non-owner viewer', () => {
    render(<ContactEmailLine contactEmail="ann@example.com" isOwner={false} onEdit={vi.fn()} />);

    expect(
      screen.queryByRole('button', { name: 'userDetail.editIdentity' })
    ).not.toBeInTheDocument();
  });
});
