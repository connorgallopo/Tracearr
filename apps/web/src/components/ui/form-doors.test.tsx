import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BindingDoors } from './form-doors';

describe('BindingDoors', () => {
  it('shows the status on the left and fires the primary door', async () => {
    const onPrimary = vi.fn();
    render(
      <BindingDoors
        primaryLabel="Save"
        pending={false}
        status={<span>Unsaved changes</span>}
        onPrimary={onPrimary}
      />
    );
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(screen.queryAllByRole('button')).toHaveLength(1);
  });

  it('disables the primary door while pending or disabled and offers the secondary one when labelled', async () => {
    const onSecondary = vi.fn();
    const { rerender } = render(
      <BindingDoors
        primaryLabel="Save"
        pending
        onPrimary={vi.fn()}
        secondaryLabel="Customize"
        onSecondary={onSecondary}
        helper="Nothing leaves until you save."
      />
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Customize' })).toBeDisabled();
    expect(screen.getByText('Nothing leaves until you save.')).toBeInTheDocument();

    rerender(
      <BindingDoors
        primaryLabel="Save"
        pending={false}
        disabled
        onPrimary={vi.fn()}
        secondaryLabel="Customize"
        onSecondary={onSecondary}
      />
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Customize' }));
    expect(onSecondary).toHaveBeenCalledTimes(1);
  });
});
