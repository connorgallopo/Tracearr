import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Appearance } from './Appearance';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/theme-provider', async () => {
  const actual = await vi.importActual<typeof import('@/components/theme-provider')>(
    '@/components/theme-provider'
  );
  return { ...actual, useTheme: vi.fn() };
});

import { useTheme } from '@/components/theme-provider';

const mockUseTheme = vi.mocked(useTheme);

function theme(overrides: Partial<ReturnType<typeof useTheme>> = {}) {
  mockUseTheme.mockReturnValue({
    theme: 'dark',
    setTheme: vi.fn(),
    accentHue: 187,
    setAccentHue: vi.fn(),
    ...overrides,
  });
}

describe('Appearance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('offers the three theme modes as one radio group with the current one pressed', () => {
    theme();

    render(<Appearance />);

    expect(screen.getByRole('radio', { name: 'general.themeDark' })).toHaveAttribute(
      'data-state',
      'on'
    );
    expect(screen.getByRole('radio', { name: 'general.themeLight' })).toHaveAttribute(
      'data-state',
      'off'
    );
    expect(screen.getByRole('radio', { name: 'general.themeSystem' })).toBeInTheDocument();
  });

  it('sets the theme to the mode that was clicked', async () => {
    const setTheme = vi.fn();
    theme({ setTheme });

    render(<Appearance />);
    await userEvent.click(screen.getByRole('radio', { name: 'general.themeLight' }));

    expect(setTheme).toHaveBeenCalledWith('light');
  });

  it('marks the saved accent preset checked and reports the hue that was picked', async () => {
    const setAccentHue = vi.fn();
    theme({ accentHue: 187, setAccentHue });

    render(<Appearance />);

    expect(screen.getByRole('radio', { name: 'Cyan' })).toBeChecked();
    await userEvent.click(screen.getByRole('radio', { name: 'Purple' }));

    expect(setAccentHue).toHaveBeenCalledWith(270);
  });

  it('offers a reset only when the theme is not the default pair', () => {
    theme({ theme: 'dark', accentHue: 187 });
    const { rerender } = render(<Appearance />);
    expect(screen.queryByRole('button', { name: /common:actions.reset/ })).not.toBeInTheDocument();

    theme({ theme: 'light', accentHue: 187 });
    rerender(<Appearance />);
    expect(screen.getByRole('button', { name: /common:actions.reset/ })).toBeInTheDocument();
  });

  it('resets both the mode and the hue to their defaults', async () => {
    const setTheme = vi.fn();
    const setAccentHue = vi.fn();
    theme({ theme: 'light', accentHue: 330, setTheme, setAccentHue });

    render(<Appearance />);
    await userEvent.click(screen.getByRole('button', { name: /common:actions.reset/ }));

    expect(setTheme).toHaveBeenCalledWith('dark');
    expect(setAccentHue).toHaveBeenCalledWith(187);
  });
});
