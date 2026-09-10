import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NewsletterPreview } from '@tracearr/shared';
import { SendNowDialog } from './SendNowDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
const previewMutate = vi.fn();
const sendMutate = vi.fn();
vi.mock('@/hooks/queries', () => ({
  usePreviewNewsletter: () => ({ mutate: previewMutate, isPending: false }),
  useSendNewsletter: () => ({ mutate: sendMutate, isPending: false }),
}));

const preview: NewsletterPreview = {
  window: {
    start: '2026-08-28T00:00:00.000Z',
    end: '2026-09-04T00:00:00.000Z',
    fromWatermark: false,
  },
  recipients: { resolved: 42, missingEmail: 2, suppressed: 1 },
  variants: [
    {
      key: 's-1',
      serverIds: ['s-1'],
      serverNames: ['Basement'],
      recipientCount: 42,
      subject: 'x',
      html: '<p/>',
      counts: { movies: 12, shows: 3, episodes: 30, albums: 0, mostWatched: 0 },
      trimmed: { movies: 0, shows: 0, albums: 0, mostWatched: 0 },
    },
  ],
};

describe('SendNowDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    previewMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (p: NewsletterPreview) => void }) => opts.onSuccess(preview)
    );
  });

  it('previews on open, states what will go out, and sends on confirm', async () => {
    const onOpenChange = vi.fn();
    render(
      <SendNowDialog newsletterId="n-1" name="Weekly" timezone="UTC" onOpenChange={onOpenChange} />
    );
    expect(previewMutate).toHaveBeenCalledWith('n-1', expect.anything());
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('newsletters.editor.send.summary:{"count":42');
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.send.confirm' }));
    expect(sendMutate).toHaveBeenCalledWith('n-1', expect.anything());
  });

  it('warns and disables sending when nobody resolves', async () => {
    previewMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (p: NewsletterPreview) => void }) =>
        opts.onSuccess({ ...preview, recipients: { resolved: 0, missingEmail: 3, suppressed: 0 } })
    );
    render(
      <SendNowDialog newsletterId="n-1" name="Weekly" timezone="UTC" onOpenChange={vi.fn()} />
    );
    await waitFor(() =>
      expect(screen.getByRole('alertdialog')).toHaveTextContent('newsletters.editor.send.nobody')
    );
    expect(screen.getByRole('button', { name: 'newsletters.editor.send.confirm' })).toBeDisabled();
  });

  it('closes on a failed preview instead of sticking on "previewing"', async () => {
    previewMutate.mockImplementation((_id: string, opts: { onError: () => void }) =>
      opts.onError()
    );
    const onOpenChange = vi.fn();
    render(
      <SendNowDialog newsletterId="n-1" name="Weekly" timezone="UTC" onOpenChange={onOpenChange} />
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(sendMutate).not.toHaveBeenCalled();
  });

  it('renders nothing while closed', () => {
    render(
      <SendNowDialog newsletterId={null} name="Weekly" timezone="UTC" onOpenChange={vi.fn()} />
    );
    expect(previewMutate).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
