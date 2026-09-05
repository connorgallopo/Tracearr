import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, Link, RouterProvider } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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

const createMutate = vi.fn();
const updateMutate = vi.fn();

vi.mock('@/hooks/queries', () => ({
  useNewsletter: vi.fn(),
  useServers: () => ({ data: [] }),
  useLibraries: () => ({ data: { data: [] }, isLoading: false }),
  useCreateNewsletter: () => ({ mutate: createMutate, isPending: false }),
  useUpdateNewsletter: () => ({ mutate: updateMutate, isPending: false }),
  useDestinations: vi.fn(),
  useSettings: vi.fn(),
  useNewsletterRecipients: vi.fn(),
  useNewsletterSends: vi.fn(),
  useUpdateUserIdentity: () => ({ mutate: vi.fn(), isPending: false }),
  usePreviewNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  useTestNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  useSendNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  newsletterKeys: { recipients: (id: string) => ['newsletters', id, 'recipients'] },
}));
vi.mock('@/components/ui/rich-text-field', () => ({
  RichTextField: ({ id }: { id: string }) => <div data-testid={`rich-${id}`} />,
}));

import { useAuth } from '@/hooks/useAuth';
import {
  useDestinations,
  useNewsletter,
  useNewsletterRecipients,
  useNewsletterSends,
  useSettings,
} from '@/hooks/queries';

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [
      {
        path: '/settings/notifications/newsletters/new',
        element: (
          <>
            <NewsletterEditor />
            <Link to="/elsewhere">elsewhere</Link>
          </>
        ),
      },
      {
        path: '/settings/notifications/newsletters/:id',
        element: (
          <>
            <NewsletterEditor />
            <Link to="/elsewhere">elsewhere</Link>
          </>
        ),
      },
      { path: '/elsewhere', element: <h1>elsewhere</h1> },
    ],
    { initialEntries: [path] }
  );
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  return { ...view, router, client };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useNewsletter).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useNewsletter>);
  vi.mocked(useDestinations).mockReturnValue({
    data: [],
  } as unknown as ReturnType<typeof useDestinations>);
  vi.mocked(useSettings).mockReturnValue({
    data: {},
  } as unknown as ReturnType<typeof useSettings>);
  vi.mocked(useNewsletterRecipients).mockReturnValue({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useNewsletterRecipients>);
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
    const { rerender, client } = renderAt('/settings/notifications/newsletters/n-1');
    expect(screen.getByTestId('newsletter-editor-loading')).toBeInTheDocument();

    vi.mocked(useNewsletter).mockReturnValue({
      data: row,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useNewsletter>);
    // A fresh router (not the loading one) forces react-router's memoized route
    // matches to recompute, so the newly-loaded row actually reaches the form.
    const loadedRouter = createMemoryRouter(
      [
        {
          path: '/settings/notifications/newsletters/:id',
          element: <NewsletterEditor />,
        },
      ],
      { initialEntries: ['/settings/notifications/newsletters/n-1'] }
    );
    rerender(
      <QueryClientProvider client={client}>
        <RouterProvider router={loadedRouter} />
      </QueryClientProvider>
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

  it('opens straight to the History tab when the URL asks for it', () => {
    vi.mocked(useNewsletter).mockReturnValue({
      data: row,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useNewsletter>);
    vi.mocked(useNewsletterSends).mockReturnValue({
      data: { sends: [], total: 0, page: 1, pageSize: 10 },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useNewsletterSends>);
    renderAt('/settings/notifications/newsletters/n-1?tab=history');
    expect(screen.getByRole('tab', { name: 'newsletters.editor.tabs.history' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByText('newsletters.history.empty')).toBeInTheDocument();
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

describe('NewsletterEditor save flows', () => {
  it('shows the unsaved dot once something changes, disables Save while invalid, and posts the whole object on create', async () => {
    createMutate.mockImplementation(
      (_body: unknown, opts: { onSuccess: (row: Newsletter) => void }) =>
        opts.onSuccess({ ...row, id: 'n-9' })
    );
    vi.mocked(useNewsletter).mockImplementation(
      (id) =>
        (id === 'n-9'
          ? { data: { ...row, id: 'n-9' }, isLoading: false, isError: false }
          : { data: undefined, isLoading: false, isError: false }) as unknown as ReturnType<
          typeof useNewsletter
        >
    );
    const { router } = renderAt('/settings/notifications/newsletters/new');
    const save = screen.getByRole('button', { name: 'newsletters.editor.save' });
    expect(save).toBeDisabled();
    expect(screen.queryByText('newsletters.editor.unsaved')).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText('newsletters.editor.name'), 'Fresh');
    expect(screen.getByText('newsletters.editor.unsaved')).toBeInTheDocument();
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(createMutate.mock.calls[0]?.[0]).toMatchObject({
      name: 'Fresh',
      enabled: true,
      links: { tracearr: false },
    });
    expect(router.state.location.pathname).toBe('/settings/notifications/newsletters/n-9');
    expect(router.state.historyAction).toBe('REPLACE');
  });

  it('patches only what moved on edit and clears the dirty state after', async () => {
    vi.mocked(useNewsletter).mockReturnValue({
      data: row,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useNewsletter>);
    updateMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (r: Newsletter) => void }) => opts.onSuccess(row)
    );
    renderAt('/settings/notifications/newsletters/n-1');
    await userEvent.type(screen.getByLabelText('newsletters.editor.name'), '!');
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.save' }));
    expect(updateMutate.mock.calls[0]?.[0]).toEqual({ id: 'n-1', data: { name: 'Weekly!' } });
    expect(screen.queryByText('newsletters.editor.unsaved')).not.toBeInTheDocument();
  });

  it('holds a dirty form on the page until the leave dialog is answered', async () => {
    renderAt('/settings/notifications/newsletters/new');
    await userEvent.type(screen.getByLabelText('newsletters.editor.name'), 'Fresh');
    await userEvent.click(screen.getByRole('link', { name: 'elsewhere' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'common:confirmations.unsavedChanges'
    );
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.cancel' }));
    expect(screen.getByLabelText('newsletters.editor.name')).toHaveValue('Fresh');
  });
});
