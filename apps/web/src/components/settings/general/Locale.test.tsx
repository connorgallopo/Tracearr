import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Settings } from '@tracearr/shared';
import { Locale } from './Locale';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@tracearr/translations', () => ({
  languageNames: { en: 'English', 'de-DE': 'Deutsch' },
  getCurrentLanguage: () => 'en',
  changeLanguage: vi.fn(),
}));

vi.mock('@/lib/dateFormat', () => ({
  getTimeFormat: () => '12h',
  setTimeFormat: vi.fn(),
  getDateRegion: vi.fn(() => 'auto'),
  setDateRegion: vi.fn(),
  getWeekStartPref: () => 'auto',
  setWeekStartPref: vi.fn(),
  getFormatLocale: () => 'en-US',
  sampleDate: () => '5/17/26 · May 17, 2026',
  dateFormatChoices: () => [
    { region: 'DE', sample: '17/05/2026 · 17 May 2026' },
    { region: 'GB', sample: '5/17/26 · May 17, 2026' },
  ],
  localeFirstDay: () => 0,
  weekdayName: (day: number) =>
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][day],
}));

vi.mock('@/hooks/queries', () => ({ useSettings: vi.fn() }));
vi.mock('@/hooks/useDebouncedSave', () => ({ useDebouncedSave: vi.fn(), TEXT_INPUT_DELAY: 1000 }));

import { changeLanguage } from '@tracearr/translations';
import { getDateRegion, setTimeFormat, setDateRegion, setWeekStartPref } from '@/lib/dateFormat';
import { useSettings } from '@/hooks/queries';
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

describe('Locale', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSettings).mockReturnValue({
      data: { unitSystem: 'metric' } as Settings,
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useDebouncedSave).mockReturnValue(saveResult('metric'));
  });

  it('shows the locale controls', () => {
    render(<Locale />);

    expect(screen.getByRole('combobox', { name: 'general.language' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'general.timeFormat' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'general.dateFormat' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'general.weekStart' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'general.unitSystem' })).toBeInTheDocument();
  });

  it('switches the app language to the chosen code', async () => {
    render(<Locale />);

    await userEvent.click(screen.getByRole('combobox', { name: 'general.language' }));
    await userEvent.click(screen.getByRole('option', { name: 'Deutsch' }));

    expect(changeLanguage).toHaveBeenCalledWith('de-DE');
  });

  it('stores the chosen clock', async () => {
    render(<Locale />);

    await userEvent.click(screen.getByRole('combobox', { name: 'general.timeFormat' }));
    await userEvent.click(screen.getByRole('option', { name: 'general.timeFormat24h' }));

    expect(setTimeFormat).toHaveBeenCalledWith('24h');
  });

  it('stores the chosen date format', async () => {
    render(<Locale />);

    await userEvent.click(screen.getByRole('combobox', { name: 'general.dateFormat' }));
    await userEvent.click(screen.getByRole('option', { name: '17/05/2026 · 17 May 2026' }));

    expect(setDateRegion).toHaveBeenCalledWith('DE');
  });

  it('stores automatic over a saved country that prints the same format', async () => {
    vi.mocked(getDateRegion).mockReturnValueOnce('GB');
    render(<Locale />);

    await userEvent.click(screen.getByRole('combobox', { name: 'general.dateFormat' }));
    await userEvent.click(
      screen.getByRole('option', { name: 'general.automatic (5/17/26 · May 17, 2026)' })
    );

    expect(setDateRegion).toHaveBeenCalledWith('auto');
  });

  it('stores the chosen first day of the week', async () => {
    render(<Locale />);

    await userEvent.click(screen.getByRole('combobox', { name: 'general.weekStart' }));
    await userEvent.click(screen.getByRole('option', { name: 'Monday' }));

    expect(setWeekStartPref).toHaveBeenCalledWith(1);
  });

  it('saves the chosen unit system', async () => {
    const setValue = vi.fn();
    vi.mocked(useDebouncedSave).mockReturnValue(saveResult('metric', setValue));
    render(<Locale />);

    await userEvent.click(screen.getByRole('combobox', { name: 'general.unitSystem' }));
    await userEvent.click(screen.getByRole('option', { name: 'general.imperial' }));

    expect(setValue).toHaveBeenCalledWith('imperial');
  });
});
