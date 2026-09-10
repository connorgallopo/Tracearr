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
  variants: [],
  recipients: [
    {
      id: 'r-1',
      address: 'ann@x.com',
      userId: 'u1',
      status: 'sent',
      variantKey: 'v',
      attempts: 1,
      error: null,
      sentAt: '2026-09-02T07:00:30.000Z',
    },
    {
      id: 'r-2',
      address: 'bob@x.com',
      userId: null,
      status: 'failed',
      variantKey: 'v',
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

  it('opens the snapshot as a modal dialog above the sheet, then retries after closing it', async () => {
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

    // Radix's modal hideOthers() aria-hides the sheet while the preview sits above it; this pins that containment.
    const sheetContent = document.querySelector('[data-slot="sheet-content"]');
    expect(sheetContent).toHaveAttribute('aria-hidden', 'true');

    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByTitle('newsletters.history.snapshotTitle')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'newsletters.history.retryFailed' }));
    expect(retryMutate).toHaveBeenCalledWith({ id: 'n-1', sendId: 's-1' });
  });

  it('shows an empty state instead of an empty recipient list while a send is still starting', () => {
    renderSheet({ recipients: [] });
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(
      'newsletters.history.recipientsEmpty'
    );
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });

  it('lists several variants with their counts, opens the snapshot of one, and says which got nothing', async () => {
    const zero = { movies: 0, shows: 0, albums: 0, mostWatched: 0 };
    renderSheet({
      variants: [
        {
          key: 's-1,s-2',
          serverIds: ['s-1', 's-2'],
          serverNames: ['Attic', 'Basement'],
          recipientCount: 1,
          trimmed: zero,
          bytes: 900,
          empty: false,
        },
        {
          key: 's-2',
          serverIds: ['s-2'],
          serverNames: ['Attic'],
          recipientCount: 3,
          trimmed: zero,
          bytes: 0,
          empty: true,
        },
      ],
    });
    const both = screen.getByRole('listitem', {
      name: 'newsletters.history.variant:{"servers":"Attic and Basement"}',
    });
    expect(both).toHaveTextContent('newsletters.history.recipients:{"count":1}');
    const attic = screen.getByRole('listitem', {
      name: 'newsletters.history.variant:{"servers":"Attic"}',
    });
    expect(attic).toHaveTextContent('newsletters.history.variantEmpty');
    expect(
      screen.queryByRole('button', {
        name: 'newsletters.history.openVariantSnapshot:{"servers":"Attic"}',
      })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'newsletters.history.openSnapshot' })
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', {
        name: 'newsletters.history.openVariantSnapshot:{"servers":"Attic and Basement"}',
      })
    );
    expect(htmlMutate).toHaveBeenCalledWith(
      { id: 'n-1', sendId: 's-1', variantKey: 's-1,s-2' },
      expect.anything()
    );
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
