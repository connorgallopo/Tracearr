import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BetaBadge } from './BetaBadge';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe('BetaBadge', () => {
  it('renders the translated beta label on the warning badge variant', () => {
    render(<BetaBadge />);

    const badge = screen.getByText('beta');
    expect(badge).toHaveAttribute('data-slot', 'badge');
    expect(badge).toHaveAttribute('data-variant', 'warning');
  });
});
