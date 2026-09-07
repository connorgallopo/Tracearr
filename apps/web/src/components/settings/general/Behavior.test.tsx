import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '@tracearr/shared';
import { Behavior } from './Behavior';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useSettings: vi.fn(),
  useImageCacheStatus: vi.fn(),
}));

vi.mock('@/hooks/useDebouncedSave', () => ({
  useDebouncedSave: vi.fn(),
  TEXT_INPUT_DELAY: 1000,
}));

import { useImageCacheStatus, useSettings } from '@/hooks/queries';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

type DebouncedSaveReturn = ReturnType<typeof useDebouncedSave>;

function saveResult(value: unknown, setValue = vi.fn()): DebouncedSaveReturn {
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

const DEFAULT_VALUES: Record<string, unknown> = {
  pollerEnabled: true,
  pollerIntervalMs: 15000,
  usePlexGeoip: false,
  pluginUpdateCheckEnabled: true,
  serverUpdateCheckEnabled: true,
};

describe('Behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSettings).mockReturnValue({
      data: DEFAULT_VALUES as unknown as Settings,
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useImageCacheStatus).mockReturnValue({
      data: undefined,
      isLoading: true,
    } as unknown as ReturnType<typeof useImageCacheStatus>);
    vi.mocked(useDebouncedSave).mockImplementation(((key: string) =>
      saveResult(DEFAULT_VALUES[key])) as typeof useDebouncedSave);
  });

  it('disables the sync interval field while session sync is off and enables it when on', () => {
    vi.mocked(useDebouncedSave).mockImplementation(((key: string) =>
      saveResult(
        key === 'pollerEnabled' ? false : DEFAULT_VALUES[key]
      )) as typeof useDebouncedSave);

    const { rerender } = render(<Behavior />);
    expect(screen.getByLabelText('general.syncInterval')).toBeDisabled();

    vi.mocked(useDebouncedSave).mockImplementation(((key: string) =>
      saveResult(DEFAULT_VALUES[key])) as typeof useDebouncedSave);
    rerender(<Behavior />);
    expect(screen.getByLabelText('general.syncInterval')).toBeEnabled();
  });

  it('shows the interval in seconds and saves the exact millisecond conversion', async () => {
    const setValue = vi.fn();
    vi.mocked(useDebouncedSave).mockImplementation(((key: string) =>
      key === 'pollerIntervalMs'
        ? saveResult(15000, setValue)
        : saveResult(DEFAULT_VALUES[key])) as typeof useDebouncedSave);

    render(<Behavior />);
    const input = screen.getByLabelText('general.syncInterval');
    expect(input).toHaveValue('15');

    await userEvent.clear(input);
    await userEvent.type(input, '20');

    expect(setValue).toHaveBeenCalledWith(20000);
  });

  it('saves the enhanced GeoIP switch as a boolean', async () => {
    const setValue = vi.fn();
    vi.mocked(useDebouncedSave).mockImplementation(((key: string) =>
      key === 'usePlexGeoip'
        ? saveResult(false, setValue)
        : saveResult(DEFAULT_VALUES[key])) as typeof useDebouncedSave);

    render(<Behavior />);
    await userEvent.click(screen.getByRole('switch', { name: 'general.enhancedGeoIP' }));

    expect(setValue).toHaveBeenCalledWith(true);
  });
});
