import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NewsletterSendDetail } from '@tracearr/shared';
import { SendDetailSheet, recipientVariant } from './SendDetailSheet';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
const htmlMutate = vi.fn();
const retryMutate = vi.fn();
vi.mock('@/hooks/queries', () => ({
  useNewsletterSend: vi.fn(),
  useNewsletterSendHtml: () => ({ mutate: htmlMutate, isPending: false }),
  useRetryFailedSend: () => ({ mutate: retryMutate, isPending: false }),
}));
import { useNewsletterSend } from '@/hooks/queries';

const detail: NewsletterSendDetail = {
  id: 's-1',
  trigger: 'manual',
  outcome: 'partial',
  windowStart: '2026-08-26T00:00:00.000Z',
  windowEnd: '2026-09-02T00:00:00.000Z',
  recipientCount: 2,
  itemCounts: { movies: 1, shows: 0, episodes: 0, albums: 0, mostWatched: 0 },
  error: null,
  startedAt: '2026-09-02T07:00:00.000Z',
  finishedAt: '2026-09-02T07:01:00.000Z',
  hasSnapshot: true,
  recipients: [
    {
      id: 'r-1',
      address: 'ann@x.com',
      userId: 'u1',
      status: 'sent',
      attempts: 1,
      error: null,
      sentAt: '2026-09-02T07:00:30.000Z',
    },
    {
      id: 'r-2',
      address: 'bob@x.com',
      userId: null,
      status: 'failed',
      attempts: 3,
      error: 'Mailbox full',
      sentAt: null,
    },
  ],
};

function renderSheet(over: Partial<NewsletterSendDetail> = {}) {
  vi.mocked(useNewsletterSend).mockReturnValue({
    data: { ...detail, ...over },
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useNewsletterSend>);
  const onOpenChange = vi.fn();
  render(
    <SendDetailSheet newsletterId="n-1" sendId="s-1" timezone="UTC" onOpenChange={onOpenChange} />
  );
  return onOpenChange;
}

describe('SendDetailSheet', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps recipient statuses to badge tones', () => {
    expect(recipientVariant('sent')).toBe('success');
    expect(recipientVariant('failed')).toBe('danger');
    expect(recipientVariant('suppressed')).toBe('warning');
    expect(recipientVariant('unknown')).toBe('outline');
    expect(recipientVariant('queued')).toBe('secondary');
  });

  it('lists recipients with status, attempts, error and sent time', () => {
    renderSheet();
    expect(useNewsletterSend).toHaveBeenCalledWith('n-1', 's-1');
    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('ann@x.com');
    expect(rows[0]).toHaveTextContent('newsletters.history.status.sent');
    expect(rows[1]).toHaveTextContent('Mailbox full');
    expect(rows[1]).toHaveTextContent('newsletters.history.attempts:{"count":3}');
  });

  it('opens the snapshot in a sandboxed frame and retries failed recipients', async () => {
    htmlMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (r: { subject: string; html: string }) => void }) =>
        opts.onSuccess({ subject: 'Weekly digest', html: '<p>Snap</p>' })
    );
    renderSheet();
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.history.openSnapshot' }));
    expect(htmlMutate).toHaveBeenCalledWith({ id: 'n-1', sendId: 's-1' }, expect.anything());
    const frame = await screen.findByTitle('newsletters.history.snapshotTitle');
    expect(frame).toHaveAttribute('sandbox', '');
    expect(frame).toHaveAttribute('srcdoc', '<p>Snap</p>');
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.history.retryFailed' }));
    expect(retryMutate).toHaveBeenCalledWith({ id: 'n-1', sendId: 's-1' });
  });

  it('disables the snapshot when pruned and hides retry for a clean send', () => {
    renderSheet({ hasSnapshot: false, outcome: 'sent' });
    expect(screen.getByRole('button', { name: 'newsletters.history.openSnapshot' })).toBeDisabled();
    expect(screen.getByText('newsletters.history.pruned')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'newsletters.history.retryFailed' })
    ).not.toBeInTheDocument();
  });
});
