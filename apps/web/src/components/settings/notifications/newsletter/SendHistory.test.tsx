import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { NewsletterSendSummary } from '@tracearr/shared';
import { SendHistory } from './SendHistory';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/hooks/queries', () => ({ useNewsletterSends: vi.fn() }));
vi.mock('./SendDetailSheet', () => ({
  SendDetailSheet: ({ sendId }: { sendId: string | null }) =>
    sendId ? <div data-testid="sheet">{sendId}</div> : null,
}));
import { useNewsletterSends } from '@/hooks/queries';

const send: NewsletterSendSummary = {
  id: 's-1',
  trigger: 'schedule',
  outcome: 'partial',
  windowStart: '2026-08-26T00:00:00.000Z',
  windowEnd: '2026-09-02T00:00:00.000Z',
  recipientCount: 42,
  itemCounts: { movies: 12, shows: 3, episodes: 30, albums: 0, mostWatched: 0 },
  error: null,
  startedAt: '2026-09-02T07:00:00.000Z',
  finishedAt: '2026-09-02T07:01:00.000Z',
  hasSnapshot: true,
  variants: [],
};

function renderHistory(
  page = { sends: [send], total: 45, page: 1, pageSize: 20 },
  isLoading = false
) {
  vi.mocked(useNewsletterSends).mockReturnValue({
    data: page,
    isLoading,
    isError: false,
  } as unknown as ReturnType<typeof useNewsletterSends>);
  return render(<SendHistory newsletterId="n-1" timezone="UTC" />);
}

describe('SendHistory', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists sends newest first with the outcome, trigger, window, counts and finish time', () => {
    renderHistory();
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('newsletters.outcome.partial');
    expect(row).toHaveTextContent('newsletters.history.trigger.schedule');
    expect(row).toHaveTextContent('newsletters.history.window:{"start":"Aug 26","end":"Sep 2"}');
    expect(row).toHaveTextContent('newsletters.history.recipients:{"count":42}');
    expect(row).toHaveTextContent('newsletters.counts.movies:{"count":12}');
    expect(useNewsletterSends).toHaveBeenCalledWith('n-1', 1);
  });

  it('pages through the shape the route answers', async () => {
    renderHistory();
    expect(screen.getByText('newsletters.history.page:{"page":1,"pages":3}')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'common:actions.previous' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.next' }));
    expect(useNewsletterSends).toHaveBeenLastCalledWith('n-1', 2);
  });

  it('opens the sheet for the selected send', async () => {
    renderHistory();
    await userEvent.click(screen.getByRole('button', { name: /newsletters.history.open/ }));
    expect(screen.getByTestId('sheet')).toHaveTextContent('s-1');
  });

  it('has an empty state and a loading state', () => {
    renderHistory({ sends: [], total: 0, page: 1, pageSize: 20 });
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(
      'newsletters.history.empty'
    );
    renderHistory({ sends: [], total: 0, page: 1, pageSize: 20 }, true);
    expect(screen.getByTestId('send-history-loading')).toBeInTheDocument();
  });
});
