import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConfirmDialog } from './confirm-dialog';

describe('ConfirmDialog', () => {
  it('falls back to the naive verb transform when no confirmLoadingLabel is given', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Reset trust score"
        description="Are you sure?"
        confirmLabel="Reset Trust Score"
        isLoading
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Reset Trust Scoring...' })).toBeInTheDocument();
  });

  it('uses the explicit confirmLoadingLabel instead of mangling confirmLabel', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Split server account"
        description="Detach this account."
        confirmLabel="Split into separate user"
        confirmLoadingLabel="Splitting..."
        isLoading
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Splitting...' })).toBeInTheDocument();
    expect(screen.queryByText(/useing/)).not.toBeInTheDocument();
  });

  it('shows the plain confirmLabel when not loading', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Split server account"
        description="Detach this account."
        confirmLabel="Split into separate user"
        confirmLoadingLabel="Splitting..."
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Split into separate user' })).toBeInTheDocument();
  });

  it('dims the destructive action in dark mode like the destructive button', () => {
    render(
      <ConfirmDialog
        open
        onOpenChange={vi.fn()}
        title="Delete"
        description="Gone for good."
        confirmLabel="Delete"
        onConfirm={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: 'Delete' })).toHaveClass('dark:bg-destructive/60');
  });
});
