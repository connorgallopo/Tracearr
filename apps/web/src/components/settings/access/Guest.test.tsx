import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Guest } from './Guest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries', () => ({ useSettings: vi.fn() }));
vi.mock('@/hooks/useDebouncedSave', () => ({ useDebouncedSave: vi.fn() }));

import { useSettings } from '@/hooks/queries';
import { useDebouncedSave } from '@/hooks/useDebouncedSave';

describe('Guest access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useSettings).mockReturnValue({
      data: { allowGuestAccess: false },
      isLoading: false,
    } as unknown as ReturnType<typeof useSettings>);
    vi.mocked(useDebouncedSave).mockReturnValue({
      value: false,
      setValue: vi.fn(),
      status: 'idle',
      errorMessage: null,
      saveNow: vi.fn(),
      reset: vi.fn(),
      retry: vi.fn(),
      isDirty: false,
      hasError: false,
    } as unknown as ReturnType<typeof useDebouncedSave>);
  });

  it('shows the switch off and disabled, because the feature is not built yet', () => {
    render(<Guest />);

    const toggle = screen.getByRole('switch', { name: 'accessControl.allowGuestAccess' });
    expect(toggle).not.toBeChecked();
    expect(toggle).toBeDisabled();
  });

  it('explains the single-owner limit in a notice', () => {
    render(<Guest />);

    expect(screen.getByRole('alert')).toHaveTextContent('accessControl.singleOwnerNote');
  });
});
