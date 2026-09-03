import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BetaBadge } from './BetaBadge';

describe('BetaBadge', () => {
  it('renders BETA on the warning badge variant', () => {
    render(<BetaBadge />);

    const badge = screen.getByText('BETA');
    expect(badge).toHaveAttribute('data-slot', 'badge');
    expect(badge).toHaveAttribute('data-variant', 'warning');
  });
});
