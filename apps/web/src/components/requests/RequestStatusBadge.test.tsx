import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import { RequestStatusBadge } from './RequestStatusBadge';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

describe('RequestStatusBadge', () => {
  it('shows pending in the warning variant', () => {
    render(<RequestStatusBadge status="pending" deletedAt={null} />);
    const badge = screen.getByText('Pending');
    expect(badge.dataset.variant).toBe('warning');
  });

  it('shows approved in the secondary variant', () => {
    render(<RequestStatusBadge status="approved" deletedAt={null} />);
    const badge = screen.getByText('Approved');
    expect(badge.dataset.variant).toBe('secondary');
  });

  it('shows completed as available in the success variant', () => {
    render(<RequestStatusBadge status="completed" deletedAt={null} />);
    const badge = screen.getByText('Available');
    expect(badge.dataset.variant).toBe('success');
  });

  it('shows declined and failed in the danger variant', () => {
    const { rerender } = render(<RequestStatusBadge status="declined" deletedAt={null} />);
    expect(screen.getByText('Declined').dataset.variant).toBe('danger');

    rerender(<RequestStatusBadge status="failed" deletedAt={null} />);
    expect(screen.getByText('Failed').dataset.variant).toBe('danger');
  });

  it('shows a muted outline badge for a deleted request regardless of status', () => {
    render(<RequestStatusBadge status="completed" deletedAt="2026-01-01T00:00:00.000Z" />);
    const badge = screen.getByText('Removed');
    expect(badge.dataset.variant).toBe('outline');
    expect(badge.className).toContain('text-muted-foreground');
  });
});
