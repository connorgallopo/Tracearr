import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Settings } from '@tracearr/shared';
import { Api } from './Api';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({
  useSettings: vi.fn(),
  useApiKey: vi.fn(),
  useRegenerateApiKey: vi.fn(),
}));

vi.mock('@/hooks/useDebouncedSave', () => ({
  useDebouncedSave: vi.fn(),
  TEXT_INPUT_DELAY: 1000,
}));

import { useApiKey, useRegenerateApiKey, useSettings } from '@/hooks/queries';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

type DebouncedSaveReturn = ReturnType<typeof useDebouncedSave>;

function saveResult(value: number, setValue = vi.fn()): DebouncedSaveReturn {
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

function renderApi() {
  return render(
    <MemoryRouter>
      <Api />
    </MemoryRouter>
  );
}

describe('Api section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSettings).mockReturnValue({
      data: {
        watchedThresholdMovie: 85,
        watchedThresholdTv: 85,
        watchedThresholdMusic: 85,
        publicApiRateLimitPerMinute: 240,
      } as Settings,
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useApiKey).mockReturnValue({
      data: { token: 'trr_abc123' },
      isLoading: false,
    } as unknown as ReturnType<typeof useApiKey>);
    vi.mocked(useRegenerateApiKey).mockReturnValue({
      mutate: vi.fn(),
      isPending: false,
    } as unknown as ReturnType<typeof useRegenerateApiKey>);
    vi.mocked(useDebouncedSave).mockImplementation(((key: string) =>
      saveResult(key === 'publicApiRateLimitPerMinute' ? 240 : 85)) as typeof useDebouncedSave);
  });

  it('shows the saved key and links the reference', () => {
    renderApi();

    expect(screen.getByDisplayValue('trr_abc123')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /general.apiDocs/ })).toHaveAttribute(
      'href',
      '/api-docs'
    );
  });

  it('masks the key by default and reveals it on request', async () => {
    renderApi();

    const key = screen.getByDisplayValue('trr_abc123');
    expect(key).toHaveAttribute('type', 'password');

    await userEvent.click(screen.getByRole('button', { name: 'Show password' }));

    expect(key).toHaveAttribute('type', 'text');
  });

  it('confirms before replacing an existing key', async () => {
    const mutate = vi.fn();
    vi.mocked(useRegenerateApiKey).mockReturnValue({
      mutate,
      isPending: false,
    } as unknown as ReturnType<typeof useRegenerateApiKey>);

    renderApi();
    await userEvent.click(screen.getByRole('button', { name: /general.regenerate/ }));

    expect(mutate).not.toHaveBeenCalled();
    expect(screen.getByText('general.regenerateApiKeyDesc')).toBeInTheDocument();
  });

  it('puts a percent unit inside each watched-threshold control', () => {
    renderApi();

    const group = screen
      .getByLabelText('general.watchedThresholdMovie')
      .closest('[data-slot="input-group"]');
    expect(group?.querySelector('[data-align="inline-end"]')).toHaveTextContent(
      'general.watchedThresholdSuffix'
    );
  });

  it('saves the rate limit under its settings key', async () => {
    const setValue = vi.fn();
    vi.mocked(useDebouncedSave).mockImplementation(((key: string) =>
      key === 'publicApiRateLimitPerMinute'
        ? saveResult(240, setValue)
        : saveResult(85)) as typeof useDebouncedSave);

    renderApi();
    await userEvent.type(screen.getByLabelText('general.apiRateLimit'), '0');

    expect(setValue).toHaveBeenCalledWith(2400);
  });
});
