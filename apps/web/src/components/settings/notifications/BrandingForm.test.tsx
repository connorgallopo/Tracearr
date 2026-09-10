import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_EMAIL_BRANDING } from '@tracearr/shared';
import { BrandingForm } from './BrandingForm';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));
const saveMutate = vi.fn();
vi.mock('@/hooks/queries', () => ({
  useEmailBranding: vi.fn(),
  useSaveEmailBranding: () => ({ mutate: saveMutate, isPending: false }),
}));
import { useEmailBranding } from '@/hooks/queries';

const stored = {
  ...DEFAULT_EMAIL_BRANDING,
  accentColor: '#123456',
  footerText: 'See you next week',
};

function renderForm(data = stored, isLoading = false) {
  vi.mocked(useEmailBranding).mockReturnValue({
    data,
    isLoading,
    isError: false,
  } as unknown as ReturnType<typeof useEmailBranding>);
  return render(<BrandingForm />);
}

describe('BrandingForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the block, edits a copy, and PUTs the whole object', async () => {
    renderForm();
    expect(screen.getByRole('button', { name: 'email.branding.save' })).toBeDisabled();
    await userEvent.click(screen.getByRole('radio', { name: 'email.branding.logo.url' }));
    await userEvent.type(
      screen.getByLabelText('email.branding.logoUrl'),
      'https://x.test/logo.png'
    );
    await userEvent.click(screen.getByRole('switch', { name: 'email.branding.mailto' }));
    await userEvent.click(screen.getByRole('button', { name: 'email.branding.save' }));
    expect(saveMutate).toHaveBeenCalledWith(
      {
        logo: { mode: 'url', url: 'https://x.test/logo.png' },
        accentColor: '#123456',
        footerText: 'See you next week',
        postalAddress: null,
        mailtoUnsubscribe: true,
      },
      expect.anything()
    );
  });

  it('keeps the hex input and the color picker in step and refuses a bad hex', async () => {
    renderForm();
    const hex = screen.getByLabelText('email.branding.accent');
    await userEvent.clear(hex);
    await userEvent.type(hex, '#abcdef');
    expect(screen.getByLabelText('email.branding.accentPicker')).toHaveValue('#abcdef');
    await userEvent.clear(hex);
    await userEvent.type(hex, 'teal');
    expect(screen.getByRole('alert')).toHaveTextContent('Expected a hex color like #0ea0b3');
    expect(screen.getByRole('button', { name: 'email.branding.save' })).toBeDisabled();
  });

  it('shows a skeleton while loading', () => {
    renderForm(stored, true);
    expect(screen.getByTestId('branding-loading')).toBeInTheDocument();
  });
});
