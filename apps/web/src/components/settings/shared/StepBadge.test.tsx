import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StepBadge } from './StepBadge';

describe('StepBadge', () => {
  it('renders the step number on a badge', () => {
    render(<StepBadge n={3} />);

    const badge = screen.getByText('3');
    expect(badge).toHaveAttribute('data-slot', 'badge');
    expect(badge).toHaveClass('size-6', 'rounded-full');
  });
});
