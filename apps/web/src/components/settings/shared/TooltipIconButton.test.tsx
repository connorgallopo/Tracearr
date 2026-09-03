import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Trash2 } from 'lucide-react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TooltipIconButton } from './TooltipIconButton';

function renderButton(overrides: Partial<React.ComponentProps<typeof TooltipIconButton>> = {}) {
  return render(
    <TooltipProvider>
      <TooltipIconButton label="Remove" icon={Trash2} onClick={vi.fn()} {...overrides} />
    </TooltipProvider>
  );
}

describe('TooltipIconButton', () => {
  it('names the button with the same label the tooltip carries', () => {
    renderButton();

    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
  });

  it('reports a click to the caller', async () => {
    const onClick = vi.fn();
    renderButton({ onClick });

    await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disables the button when asked', () => {
    renderButton({ disabled: true });

    expect(screen.getByRole('button', { name: 'Remove' })).toBeDisabled();
  });
});
