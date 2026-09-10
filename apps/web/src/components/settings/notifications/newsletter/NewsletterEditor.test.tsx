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
  useServers: vi.fn(() => ({ data: [] })),
  useLibraries: () => ({ data: { data: [] }, isLoading: false }),
  useCreateNewsletter: () => ({ mutate: createMutate, isPending: false }),
  useUpdateNewsletter: () => ({ mutate: updateMutate, isPending: false }),
  useDestinations: vi.fn(),
  useSettings: vi.fn(),
  useNewsletterRecipients: vi.fn(),
  useNewsletterSends: vi.fn(),
  useNewsletterVariants: () => ({ data: undefined }),
  useUpdateUserIdentity: () => ({ mutate: vi.fn(), isPending: false }),
  usePreviewNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  usePreviewDraftNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  useTestNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  useSendNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
  newsletterKeys: { recipients: (id: string) => ['newsletters', id, 'recipients'] },
}));
vi.mock('@/components/ui/rich-text-field', () => ({
  RichTextField: ({
    id,
    onChange,
  }: {
    id: string;
    onChange: (change: { value: unknown; error: string | null }) => void;
  }) => (
    <div id={id} data-testid={`rich-${id}`} tabIndex={-1}>
      <button
        type="button"
        onClick={() =>
          onChange({
            value: {
              type: 'doc',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(2100) }] }],
            },
            error: null,
          })
        }
      >
        {`overfill ${id}`}
      </button>
    </div>
  ),
}));

import { useAuth } from '@/hooks/useAuth';
import {
  useDestinations,
  useNewsletter,
  useNewsletterRecipients,
  useNewsletterSends,
  useServers,
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
  scope: { serverIds: [], libraries: [] },
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
  it('opens a new row on the defaults with a create title and a disabled History tab', () => {
    renderAt('/settings/notifications/newsletters/new');
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(
      'newsletters.editor.newTitle'
    );
    expect(screen.getByLabelText('newsletters.editor.name')).toHaveValue('');
    expect(screen.getByLabelText('newsletters.editor.subject')).toHaveValue(
      "What's new on {{server_name}} ({{end_date}})"
    );
    expect(screen.getByRole('tab', { name: 'newsletters.editor.tabs.edit' })).toHaveAttribute(
      'aria-selected',
      'true'
    );
    expect(screen.getByRole('tab', { name: 'newsletters.editor.tabs.history' })).toBeDisabled();
    expect(
      screen.getByRole('heading', { level: 3, name: 'newsletters.editor.basics' })
    ).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.nameHelp')).toBeInTheDocument();
    expect(
      screen.getByRole('switch', { name: 'newsletters.editor.links.tracearr' })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { level: 3, name: 'newsletters.editor.links.title' })
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(document.querySelector('[aria-invalid="true"]')).toBeNull();
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
    // A fresh router (not the loading one) forces react-router's memoized route matches to recompute, so the newly-loaded row actually reaches the form.
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
    expect(
      screen.getByText(
        'newsletters.schedule.inZone:{"summary":"newsletters.schedule.daily:{\\"time\\":\\"7:15 AM\\"}","timezone":"Europe/Berlin"}'
      )
    ).toBeInTheDocument();
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

  it('puts the recipient count in the header once the saved view resolves', () => {
    vi.mocked(useNewsletter).mockReturnValue({
      data: row,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useNewsletter>);
    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: {
        recipients: [
          {
            address: 'ann@x.com',
            userId: 'u1',
            serverUserId: 'su-1',
            name: 'Ann',
            suppressed: false,
            username: 'ann',
            serverId: 's1',
            serverName: 'Home Plex',
            serverIds: ['s1'],
            thumbUrl: null,
          },
        ],
        missing: [],
        excluded: [],
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    renderAt('/settings/notifications/newsletters/n-1');
    expect(
      screen.getByText(
        'newsletters.editor.headerSummary:{"schedule":"newsletters.schedule.inZone:{\\"summary\\":\\"newsletters.schedule.daily:{\\\\\\"time\\\\\\":\\\\\\"7:15 AM\\\\\\"}\\",\\"timezone\\":\\"Europe/Berlin\\"}","recipients":"newsletters.editor.readiness.recipients:{\\"count\\":1}"}'
      )
    ).toBeInTheDocument();
  });

  it('paints the required error only once Name has been left empty', async () => {
    renderAt('/settings/notifications/newsletters/new');
    const name = screen.getByLabelText('newsletters.editor.name');
    await userEvent.type(name, 'W');
    await userEvent.clear(name);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.tab();
    expect(screen.getByRole('alert')).toHaveTextContent('common:validation.required');
    expect(name).toHaveAttribute('aria-invalid', 'true');
  });
});

describe('NewsletterEditor save flows', () => {
  it('keeps Save enabled while invalid, refuses inline with focus on the first bad field, and posts the whole object once valid', async () => {
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

    await userEvent.type(screen.getByLabelText('newsletters.editor.subject'), '!');
    expect(screen.getByText('newsletters.editor.unsaved')).toBeInTheDocument();
    expect(save).toBeEnabled();
    await userEvent.click(save);
    expect(screen.getByText('newsletters.editor.fixFirst')).toBeInTheDocument();
    expect(screen.getByLabelText('newsletters.editor.name')).toHaveFocus();
    expect(screen.getByLabelText('newsletters.editor.name')).toHaveAttribute(
      'aria-invalid',
      'true'
    );
    expect(createMutate).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('newsletters.editor.name'), 'Fresh');
    expect(screen.queryByText('newsletters.editor.fixFirst')).not.toBeInTheDocument();
    await userEvent.click(save);
    expect(createMutate.mock.calls[0]?.[0]).toMatchObject({
      name: 'Fresh',
      enabled: true,
      subject: "What's new on {{server_name}} ({{end_date}})!",
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

  it('sends focus to a rich text field the editor called clean but the schema rejects', async () => {
    renderAt('/settings/notifications/newsletters/new');
    await userEvent.type(screen.getByLabelText('newsletters.editor.name'), 'Fresh');
    await userEvent.click(await screen.findByRole('button', { name: 'overfill newsletter-intro' }));
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.save' }));
    expect(createMutate).not.toHaveBeenCalled();
    expect(screen.getByTestId('rich-newsletter-intro')).toHaveFocus();
  });

  it('forgets the refusal after a save, so the next invalid keystroke stays quiet', async () => {
    vi.mocked(useNewsletter).mockReturnValue({
      data: row,
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useNewsletter>);
    updateMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (r: Newsletter) => void }) => opts.onSuccess(row)
    );
    renderAt('/settings/notifications/newsletters/n-1');
    const name = screen.getByLabelText('newsletters.editor.name');
    await userEvent.type(name, '!');
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.save' }));
    await userEvent.clear(name);
    expect(screen.queryByText('newsletters.editor.fixFirst')).not.toBeInTheDocument();
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

  it('refuses the save with the sender-name sentence when two servers are in scope, then saves once a name is typed', async () => {
    vi.mocked(useServers).mockReturnValue({
      data: [
        { id: 's-1', name: 'Basement', type: 'plex' },
        { id: 's-2', name: 'Attic', type: 'jellyfin' },
      ],
    } as unknown as ReturnType<typeof useServers>);
    vi.mocked(useNewsletter).mockReturnValue({
      data: { ...row, senderName: null },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useNewsletter>);
    updateMutate.mockImplementation(
      (_vars: unknown, opts: { onSuccess: (r: Newsletter) => void }) => opts.onSuccess(row)
    );
    renderAt('/settings/notifications/newsletters/n-1');
    await userEvent.type(screen.getByLabelText('newsletters.editor.name'), '!');
    expect(screen.queryByText(/senderNameRequiredMulti/)).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.save' }));
    expect(
      screen.getByText('newsletters.editor.senderNameRequiredMulti:{"count":2}')
    ).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.fixFirst')).toBeInTheDocument();
    expect(screen.getByLabelText('newsletters.editor.senderName')).toHaveFocus();
    expect(updateMutate).not.toHaveBeenCalled();

    await userEvent.type(screen.getByLabelText('newsletters.editor.senderName'), 'Family');
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.editor.save' }));
    expect(updateMutate.mock.calls[0]?.[0]).toEqual({
      id: 'n-1',
      data: { name: 'Weekly!', senderName: 'Family' },
    });
  });
});
