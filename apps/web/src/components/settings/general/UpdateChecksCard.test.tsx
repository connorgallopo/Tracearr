import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '@tracearr/shared';
import { UpdateChecksCard } from './UpdateChecksCard';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useSettings: vi.fn(),
}));

vi.mock('@/hooks/useDebouncedSave', () => ({
  useDebouncedSave: vi.fn(),
  TEXT_INPUT_DELAY: 1000,
}));

import { useSettings } from '@/hooks/queries';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

const mockUseSettings = vi.mocked(useSettings);
const mockUseDebouncedSave = vi.mocked(useDebouncedSave);

type DebouncedSaveReturn = ReturnType<typeof useDebouncedSave>;

function saveResult(value: boolean, setValue = vi.fn()): DebouncedSaveReturn {
  return {
    value,
    setValue,
    status: 'idle',
    errorMessage: null,
    saveNow: vi.fn(),
    reset: vi.fn(),
    retry: vi.fn(),
    isDirty: false,
    hasError: false,
  } as unknown as DebouncedSaveReturn;
}

function settingsData(overrides: Partial<Settings> = {}): Settings {
  return {
    pluginUpdateCheckEnabled: true,
    serverUpdateCheckEnabled: true,
    ...overrides,
  } as Settings;
}

describe('UpdateChecksCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSettings.mockReturnValue({
      data: settingsData(),
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
  });

  it('shows a switch per check, set from the saved settings', () => {
    mockUseDebouncedSave.mockImplementation((key) =>
      saveResult(key === 'pluginUpdateCheckEnabled')
    );

    render(<UpdateChecksCard />);

    expect(screen.getByRole('switch', { name: 'general.updateChecks.plugin' })).toBeChecked();
    expect(screen.getByRole('switch', { name: 'general.updateChecks.server' })).not.toBeChecked();
  });

  it('saves the media-server toggle through its own field', async () => {
    const setServerValue = vi.fn();
    mockUseDebouncedSave.mockImplementation((key) =>
      key === 'serverUpdateCheckEnabled' ? saveResult(true, setServerValue) : saveResult(true)
    );

    render(<UpdateChecksCard />);
    await userEvent.click(screen.getByRole('switch', { name: 'general.updateChecks.server' }));

    expect(setServerValue).toHaveBeenCalledWith(false);
  });

  it('asks for both toggles by their settings keys', () => {
    mockUseDebouncedSave.mockImplementation(() => saveResult(true));

    render(<UpdateChecksCard />);

    const keys = mockUseDebouncedSave.mock.calls.map(([key]) => key);
    expect(keys).toContain('pluginUpdateCheckEnabled');
    expect(keys).toContain('serverUpdateCheckEnabled');
  });
});
