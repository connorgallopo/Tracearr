import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import type { Newsletter } from '@tracearr/shared';
import { NewsletterEditor } from './NewsletterEditor';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));
vi.mock('@/hooks/queries', () => ({
  useNewsletter: vi.fn(),
  useServers: () => ({ data: [] }),
  useLibraries: () => ({ data: { data: [] }, isLoading: false }),
}));
vi.mock('@/components/ui/rich-text-field', () => ({
  RichTextField: ({ id }: { id: string }) => <div data-testid={`rich-${id}`} />,
}));

import { useAuth } from '@/hooks/useAuth';
import { useNewsletter } from '@/hooks/queries';

const row = {
  id: 'n-1',
  name: 'Weekly',
  enabled: false,
  destinationId: null,
  schedule: { kind: 'daily', time: '07:15' },
  timezone: 'Europe/Berlin',
  window: { kind: 'fixed', days: 3 },
  scope: { serverIds: [], libraryIds: [] },
  sections: {
    movies: { enabled: true, max: 12 },
    shows: { enabled: true, max: 12, maxSeasonsPerShow: 8 },
    music: { enabled: true, max: 8 },
    mostWatched: { enabled: false, max: 10 },
  },
  subject: 'Hello',
  senderName: 'Family',
  intro: null,
  outro: null,
  recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
  imageMode: 'auto',
  skipWhenEmpty: true,
  links: { tracearr: false },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  lastSend: null,
  nextRunAt: '2026-09-05T05:15:00.000Z',
} as Newsletter;

function renderAt(path: string, role = 'owner') {
  vi.mocked(useAuth).mockReturnValue({
    user: { role, email: 'me@example.com' },
  } as unknown as ReturnType<typeof useAuth>);
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/settings/notifications/newsletters/new" element={<NewsletterEditor />} />
        <Route path="/settings/notifications/newsletters/:id" element={<NewsletterEditor />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useNewsletter).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useNewsletter>);
});

describe('NewsletterEditor', () => {
  it('opens a new row on the defaults with a create title and no tabs', () => {
    renderAt('/settings/notifications/newsletters/new');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'newsletters.editor.newTitle'
    );
    expect(screen.getByLabelText('newsletters.editor.name')).toHaveValue('');
    expect(screen.getByLabelText('newsletters.editor.subject')).toHaveValue(
      "What's new on {{server_name}} ({{end_date}})"
    );
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(useNewsletter).toHaveBeenCalledWith(undefined);
  });

  it('shows a skeleton while the row loads, then seeds the form and the tabs from it', () => {
    vi.mocked(useNewsletter).mockReturnValueOnce({
      data: undefined,
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useNewsletter>);
    const { rerender } = renderAt('/settings/notifications/newsletters/n-1');
    expect(screen.getByTestId('newsletter-editor-loading')).toBeInTheDocument();

    vi.mocked(useNewsletter).mockReturnValue({
      data: row,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useNewsletter>);
    rerender(
      <MemoryRouter initialEntries={['/settings/notifications/newsletters/n-1']}>
        <Routes>
          <Route path="/settings/notifications/newsletters/:id" element={<NewsletterEditor />} />
        </Routes>
      </MemoryRouter>
    );
    expect(useNewsletter).toHaveBeenCalledWith('n-1');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('Weekly');
    expect(screen.getByLabelText('newsletters.editor.name')).toHaveValue('Weekly');
    expect(screen.getByLabelText('newsletters.editor.senderName')).toHaveValue('Family');
    expect(screen.getByRole('tab', { name: 'newsletters.editor.tabs.edit' })).toBeInTheDocument();
    expect(
      screen.getByRole('tab', { name: 'newsletters.editor.tabs.history' })
    ).toBeInTheDocument();
    expect(screen.getByText(/newsletters.editor.nextRun/)).toBeInTheDocument();
  });

  it('gates non-owners and reports a load error', () => {
    renderAt('/settings/notifications/newsletters/new', 'admin');
    expect(screen.getByRole('alert')).toHaveTextContent('newsletters.ownerOnly');
    vi.mocked(useNewsletter).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('Newsletter not found'),
    } as unknown as ReturnType<typeof useNewsletter>);
    renderAt('/settings/notifications/newsletters/n-9');
    // apps/web's tsconfig lib omits general ES2022 Array methods, so Array#at is unavailable here.
    const alerts = screen.getAllByRole('alert');
    expect(alerts[alerts.length - 1]).toHaveTextContent('Newsletter not found');
  });
});
