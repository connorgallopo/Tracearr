import type { ComponentProps, ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { NewsletterRecipients, NewsletterRecipientsView } from '@tracearr/shared';
import { getAvatarUrl } from '@/components/users/utils';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
const identityMutate = vi.fn();
const refetch = vi.fn();
vi.mock('@/hooks/queries', () => ({
  useNewsletterRecipients: vi.fn(),
  useUpdateUserIdentity: () => ({ mutate: identityMutate, isPending: false }),
  newsletterKeys: { recipients: (id: string) => ['newsletters', id, 'recipients'] },
}));
// Radix's Avatar image only mounts once the browser reports the image loaded, which jsdom never does.
vi.mock('@/components/ui/avatar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/avatar')>();
  return {
    ...actual,
    AvatarImage: (props: ComponentProps<'img'>) => <img alt="" {...props} />,
  };
});
import { useNewsletterRecipients, newsletterKeys } from '@/hooks/queries';
import {
  RecipientsPanel,
  partitionRecipients,
  extraRecipients,
  groupByVariant,
} from './RecipientsPanel';

let queryClient: QueryClient;

/** The Members-off suppression note peeks at the query cache directly, so every render needs a real client. */
function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const view: NewsletterRecipientsView = {
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
    {
      address: 'gone@x.com',
      userId: 'u2',
      serverUserId: 'su-2',
      name: 'Bob',
      suppressed: true,
      username: 'bob',
      serverId: 's1',
      serverName: 'Home Plex',
      serverIds: ['s1'],
      thumbUrl: null,
    },
    {
      address: 'extra@x.com',
      userId: null,
      serverUserId: null,
      name: null,
      suppressed: false,
      username: null,
      serverId: null,
      serverName: null,
      serverIds: [],
      thumbUrl: null,
    },
  ],
  missing: [
    {
      userId: 'u3',
      serverUserId: 'su-3',
      name: 'Cid',
      username: 'cid',
      serverId: 's1',
      serverName: 'Home Plex',
      serverIds: ['s1'],
      thumbUrl: null,
    },
  ],
  excluded: [
    {
      userId: 'u4',
      serverUserId: 'su-4',
      name: 'Dee',
      username: 'dee',
      serverId: 's1',
      serverName: 'Home Plex',
      serverIds: ['s1'],
      thumbUrl: null,
      reason: 'excluded',
    },
    {
      userId: 'u5',
      serverUserId: 'su-5',
      name: 'Eve',
      username: 'eve',
      serverId: 's1',
      serverName: 'Home Plex',
      serverIds: ['s1'],
      thumbUrl: null,
      reason: 'banned',
    },
  ],
};

const servers = [
  { id: 's1', name: 'Home Plex' },
  { id: 's2', name: 'Attic' },
];

function renderPanel(
  over: Partial<NewsletterRecipients> = {},
  id: string | null = 'n-1',
  panelServers: { id: string; name: string }[] = [{ id: 's1', name: 'Home Plex' }],
  staleScope = false
) {
  const onExclude = vi.fn();
  const onInclude = vi.fn();
  const onPreview = vi.fn();
  vi.mocked(useNewsletterRecipients).mockReturnValue({
    data: view,
    isLoading: false,
    isError: false,
    refetch,
  } as unknown as ReturnType<typeof useNewsletterRecipients>);
  const { unmount } = render(
    <Providers>
      <RecipientsPanel
        newsletterId={id}
        recipients={{ members: true, extraAddresses: [], excludeUserIds: ['u4'], ...over }}
        onExclude={onExclude}
        onInclude={onInclude}
        servers={panelServers}
        staleScope={staleScope}
        onPreview={onPreview}
      />
    </Providers>
  );
  return { onExclude, onInclude, onPreview, unmount };
}

describe('groupByVariant', () => {
  it('puts each row under the scoped servers it belongs to, extras under the union, union first', () => {
    const rows = [
      { userId: 'u1', serverIds: ['s1'] },
      { userId: null, serverIds: [] },
      { userId: 'u2', serverIds: ['s2', 's1'] },
      { userId: 'u3', serverIds: ['s2'] },
    ];
    const groups = groupByVariant(rows, [
      { id: 's2', name: 'Attic' },
      { id: 's1', name: 'Home Plex' },
    ]);
    expect(groups.map((g) => [g.key, g.serverNames, g.rows.map((r) => r.userId)])).toEqual([
      ['s1,s2', ['Attic', 'Home Plex'], [null, 'u2']],
      ['s1', ['Home Plex'], ['u1']],
      ['s2', ['Attic'], ['u3']],
    ]);
  });
});

describe('partitionRecipients', () => {
  it('moves a locally excluded person to the excluded list and a locally included one back', () => {
    const out = partitionRecipients(view, ['u4', 'u1']);
    expect(out.receive.map((r) => r.address)).toEqual(['extra@x.com']);
    expect(out.suppressed.map((r) => r.address)).toEqual(['gone@x.com']);
    expect(partitionRecipients(view, ['u4', 'u2']).suppressed).toEqual([]);
    expect(out.excluded.map((p) => [p.userId, p.reason, p.pending])).toEqual([
      ['u4', 'excluded', false],
      ['u5', 'banned', false],
      ['u1', 'excluded', true],
    ]);
    const back = partitionRecipients(view, []);
    expect(back.excluded.map((p) => p.userId)).toEqual(['u5']);
    expect(back.included.map((p) => p.userId)).toEqual(['u4']);
  });
});

describe('RecipientsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  });

  it('heads each group with its people, explains the split once, and does neither for one server', () => {
    const { unmount } = renderPanel({ excludeUserIds: [] }, 'n-1', servers);
    const headings = screen
      .getAllByText(/newsletters\.editor\.variantHeading/)
      .map((el) => el.textContent);
    expect(headings).toEqual([
      'newsletters.editor.variantHeading:{"count":1,"servers":"Home Plex and Attic"}',
      'newsletters.editor.variantHeading:{"count":2,"servers":"Home Plex"}',
    ]);
    expect(screen.getByText('newsletters.editor.recipients.groupsNote')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'extra@x.com' })).toBeInTheDocument();
    unmount();

    renderPanel({ excludeUserIds: [] });
    expect(screen.queryByText(/newsletters\.editor\.variantHeading/)).not.toBeInTheDocument();
    expect(screen.queryByText('newsletters.editor.recipients.groupsNote')).not.toBeInTheDocument();
  });

  it('offers Preview from the create-mode empty state instead of asking the server', async () => {
    const { onPreview } = renderPanel({ excludeUserIds: [] }, null);
    expect(
      screen.getByRole('heading', { level: 3, name: 'newsletters.editor.recipients.saveFirst' })
    ).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.recipients.saveFirstHelp')).toBeInTheDocument();
    expect(useNewsletterRecipients).toHaveBeenCalledWith(undefined);
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.actions.preview' })
    );
    expect(onPreview).toHaveBeenCalled();
  });

  it('counts a person coming back from Excluded in the header, the same as the groups below', () => {
    renderPanel({ excludeUserIds: [] });
    expect(
      screen.getByText('newsletters.editor.recipients.willReceive:{"count":3}')
    ).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: 'Dee' })).toHaveTextContent(
      'newsletters.editor.recipients.includedAfterSave'
    );
  });

  it('hides the no-address block when everyone has one', () => {
    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: { ...view, missing: [] },
      isLoading: false,
      isError: false,
      refetch,
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    render(
      <Providers>
        <RecipientsPanel
          newsletterId="n-1"
          recipients={{ members: true, extraAddresses: [], excludeUserIds: [] }}
          onExclude={vi.fn()}
          onInclude={vi.fn()}
          servers={[{ id: 's1', name: 'Home Plex' }]}
          staleScope={false}
          onPreview={vi.fn()}
        />
      </Providers>
    );
    expect(
      screen.queryByText(/newsletters\.editor\.recipients\.noAddress/)
    ).not.toBeInTheDocument();
  });

  it('says the list reflects the saved servers when the scope has moved', () => {
    renderPanel({}, 'n-1', servers, true);
    expect(screen.getByRole('alert')).toHaveTextContent('newsletters.editor.recipients.staleScope');
  });

  it('explains what Exclude does inside the excluded list', async () => {
    renderPanel();
    await userEvent.click(
      screen.getByRole('button', {
        name: 'newsletters.editor.recipients.excludedCount:{"count":2}',
      })
    );
    expect(screen.getByText('newsletters.editor.recipients.excludedHelp')).toBeInTheDocument();
  });

  it('prefills the address box with a username that is already an email, and leaves the rest empty', () => {
    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: {
        recipients: [],
        missing: [
          {
            userId: 'u7',
            serverUserId: 'su-7',
            name: 'Fay',
            username: 'fay@x.com',
            serverId: 's1',
            serverName: 'Home Plex',
            serverIds: ['s1'],
            thumbUrl: null,
          },
          {
            userId: 'u8',
            serverUserId: 'su-8',
            name: 'Gil',
            username: 'gil',
            serverId: 's1',
            serverName: 'Home Plex',
            serverIds: ['s1'],
            thumbUrl: null,
          },
        ],
        excluded: [],
      },
      isLoading: false,
      isError: false,
      refetch,
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    render(
      <Providers>
        <RecipientsPanel
          newsletterId="n-1"
          recipients={{ members: true, extraAddresses: [], excludeUserIds: [] }}
          onExclude={vi.fn()}
          onInclude={vi.fn()}
          servers={[{ id: 's1', name: 'Home Plex' }]}
          staleScope={false}
          onPreview={vi.fn()}
        />
      </Providers>
    );
    expect(
      screen.getByLabelText('newsletters.editor.recipients.contactEmailFor:{"name":"Fay"}')
    ).toHaveValue('fay@x.com');
    expect(
      screen.getByLabelText('newsletters.editor.recipients.contactEmailFor:{"name":"Gil"}')
    ).toHaveValue('');
  });

  it('lists who will receive with counts, a suppressed badge, and an exclude action for members', async () => {
    const { onExclude } = renderPanel();
    expect(
      screen.getByText('newsletters.editor.recipients.willReceive:{"count":2}')
    ).toBeInTheDocument();
    expect(
      screen.getByText('newsletters.editor.recipients.suppressedHeading:{"count":1}')
    ).toBeInTheDocument();
    expect(
      screen.getByText('newsletters.editor.recipients.noAddress:{"count":1}')
    ).toBeInTheDocument();
    expect(
      screen.getByText('newsletters.editor.recipients.excludedCount:{"count":2}')
    ).toBeInTheDocument();
    const bob = screen.getByRole('listitem', { name: 'Bob' });
    expect(bob).toHaveTextContent('newsletters.editor.recipients.suppressed');
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.exclude:{"name":"Ann"}' })
    );
    expect(onExclude).toHaveBeenCalledWith('u1');
    expect(screen.queryByRole('button', { name: /exclude.*extra/ })).not.toBeInTheDocument();
  });

  it('patches a contact email inline through the account id and refetches', async () => {
    identityMutate.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) =>
      opts.onSuccess()
    );
    renderPanel();
    const input = screen.getByLabelText(
      'newsletters.editor.recipients.contactEmailFor:{"name":"Cid"}'
    );
    await userEvent.type(input, 'cid@x.com');
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.saveEmail:{"name":"Cid"}' })
    );
    expect(identityMutate).toHaveBeenCalledWith(
      { id: 'su-3', data: { contactEmail: 'cid@x.com' } },
      expect.anything()
    );
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole('link', {
        name: 'newsletters.editor.recipients.openUserPage:{"name":"Cid"}',
      })
    ).toHaveAttribute('href', '/users/su-3');
  });

  it('shows the excluded list collapsed with an include action', async () => {
    const { onInclude } = renderPanel();
    expect(screen.queryByText('Dee')).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', {
        name: 'newsletters.editor.recipients.excludedCount:{"count":2}',
      })
    );
    expect(
      within(screen.getByRole('listitem', { name: 'Eve' })).queryByRole('button')
    ).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.include:{"name":"Dee"}' })
    );
    expect(onInclude).toHaveBeenCalledWith('u4');
  });

  it('offers an Exclude action on a person moved back from Excluded, same as any recipient', async () => {
    const { onExclude } = renderPanel({ excludeUserIds: [] });
    expect(screen.getByRole('listitem', { name: 'Dee' })).toHaveTextContent(
      'newsletters.editor.recipients.includedAfterSave'
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.exclude:{"name":"Dee"}' })
    );
    expect(onExclude).toHaveBeenCalledWith('u4');
  });

  it('shows an empty state when nobody resolves to a recipient at all', () => {
    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: { recipients: [], missing: [], excluded: [] },
      isLoading: false,
      isError: false,
      refetch,
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    render(
      <Providers>
        <RecipientsPanel
          newsletterId="n-1"
          recipients={{ members: true, extraAddresses: [], excludeUserIds: [] }}
          onExclude={vi.fn()}
          onInclude={vi.fn()}
          servers={[]}
          staleScope={false}
          onPreview={vi.fn()}
        />
      </Providers>
    );
    expect(screen.getByText('newsletters.editor.recipients.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.recipients.emptyDescription')).toBeInTheDocument();
    expect(
      screen.queryByText('newsletters.editor.recipients.willReceive:{"count":0}')
    ).not.toBeInTheDocument();
  });

  it('shows only the extra addresses when members are off and never asks the server', () => {
    renderPanel({
      members: false,
      extraAddresses: [
        { address: ' Ann@X.com ', name: 'Ann' },
        { address: 'ann@x.com' },
        { address: 'nope' },
        { address: 'bo@x.com' },
      ],
    });
    expect(useNewsletterRecipients).toHaveBeenCalledWith(undefined);
    expect(
      screen.getByText('newsletters.editor.recipients.willReceive:{"count":2}')
    ).toBeInTheDocument();
    // The typed casing survives display; only the dedupe key lower-cases.
    expect(screen.getByRole('listitem', { name: 'Ann@X.com' })).toHaveTextContent('Ann');
    expect(screen.getByRole('listitem', { name: 'bo@x.com' })).toBeInTheDocument();
    expect(screen.queryByText('Cid')).not.toBeInTheDocument();
  });

  it('shows the empty state when members are off and no extra addresses are typed', () => {
    renderPanel({ members: false, extraAddresses: [] });
    expect(screen.getByText('newsletters.editor.recipients.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.recipients.emptyDescription')).toBeInTheDocument();
    expect(
      screen.queryByText('newsletters.editor.recipients.willReceive:{"count":0}')
    ).not.toBeInTheDocument();
  });

  it('notes a cached suppressed address when members are off, without asking the server again', () => {
    queryClient.setQueryData(newsletterKeys.recipients('n-1'), {
      recipients: [
        {
          address: 'ann@x.com',
          userId: 'u1',
          serverUserId: 'su-1',
          name: 'Ann',
          suppressed: true,
          username: 'ann',
          serverId: 's1',
          serverName: 'Home Plex',
          serverIds: ['s1'],
          thumbUrl: null,
        },
      ],
      missing: [],
      excluded: [],
    } satisfies NewsletterRecipientsView);
    renderPanel({
      members: false,
      extraAddresses: [{ address: 'ann@x.com' }, { address: 'bo@x.com' }],
    });
    expect(useNewsletterRecipients).toHaveBeenCalledWith(undefined);
    expect(
      screen.getByText('newsletters.editor.recipients.membersOffSuppressed:{"count":1}')
    ).toBeInTheDocument();
  });

  it('restores the resolved list when members are on again', () => {
    renderPanel({ members: true });
    expect(useNewsletterRecipients).toHaveBeenCalledWith('n-1');
    expect(screen.getByRole('listitem', { name: 'Ann' })).toBeInTheDocument();
  });

  it('shows a missing-address person by their username, linked to their page, with no uuid on screen', () => {
    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: {
        recipients: [],
        missing: [
          {
            userId: 'u9',
            serverUserId: 'su-9',
            name: null,
            username: 'garry',
            serverId: 's2',
            serverName: 'Basement Jellyfin',
            thumbUrl: null,
          },
        ],
        excluded: [],
      },
      isLoading: false,
      isError: false,
      refetch,
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    render(
      <Providers>
        <RecipientsPanel
          newsletterId="n-1"
          recipients={{ members: true, extraAddresses: [], excludeUserIds: [] }}
          onExclude={vi.fn()}
          onInclude={vi.fn()}
          servers={[]}
          staleScope={false}
          onPreview={vi.fn()}
        />
      </Providers>
    );
    const link = screen.getByRole('link', {
      name: 'newsletters.editor.recipients.openUserPage:{"name":"garry"}',
    });
    expect(link).toHaveTextContent('garry');
    expect(link).toHaveAttribute('href', '/users/su-9');
    expect(
      screen.getByText(
        'newsletters.editor.recipients.account:{"username":"garry","server":"Basement Jellyfin"}'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText(/[0-9a-f]{8}-[0-9a-f]{4}/)).not.toBeInTheDocument();
  });

  it('renders a member with an address using the account avatar, a name link, and the email in the muted line', () => {
    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: {
        recipients: [
          {
            address: 'sarah@x.com',
            userId: 'u1',
            serverUserId: 'su-1',
            name: 'Sarah',
            suppressed: false,
            username: 'sarah',
            serverId: 's1',
            serverName: 'Home Plex',
            thumbUrl: '/library/avatar.png',
          },
        ],
        missing: [],
        excluded: [],
      },
      isLoading: false,
      isError: false,
      refetch,
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    render(
      <Providers>
        <RecipientsPanel
          newsletterId="n-1"
          recipients={{ members: true, extraAddresses: [], excludeUserIds: [] }}
          onExclude={vi.fn()}
          onInclude={vi.fn()}
          servers={[]}
          staleScope={false}
          onPreview={vi.fn()}
        />
      </Providers>
    );
    const row = screen.getByRole('listitem', { name: 'Sarah' });
    const img = row.querySelector('img');
    expect(img).toHaveAttribute('src', getAvatarUrl('s1', '/library/avatar.png', 40) ?? '');
    expect(screen.getByRole('link', { name: /Sarah/ })).toHaveAttribute('href', '/users/su-1');
    expect(
      screen.getByText(
        'sarah@x.com · newsletters.editor.recipients.account:{"username":"sarah","server":"Home Plex"}'
      )
    ).toBeInTheDocument();
  });

  it('renders an extra address with a Mail icon, the address as the title, and no link', () => {
    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: {
        recipients: [
          {
            address: 'guest@x.com',
            userId: null,
            serverUserId: null,
            name: null,
            suppressed: false,
            username: null,
            serverId: null,
            serverName: null,
            thumbUrl: null,
          },
        ],
        missing: [],
        excluded: [],
      },
      isLoading: false,
      isError: false,
      refetch,
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    render(
      <Providers>
        <RecipientsPanel
          newsletterId="n-1"
          recipients={{ members: true, extraAddresses: [], excludeUserIds: [] }}
          onExclude={vi.fn()}
          onInclude={vi.fn()}
          servers={[]}
          staleScope={false}
          onPreview={vi.fn()}
        />
      </Providers>
    );
    const row = screen.getByRole('listitem', { name: 'guest@x.com' });
    expect(row).toHaveTextContent('guest@x.com');
    expect(row).toHaveTextContent('newsletters.editor.recipients.extraAddress');
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    expect(within(row).queryByRole('img')).not.toBeInTheDocument();
  });
});

describe('extraRecipients', () => {
  it('normalizes for dedupe but displays the typed casing, and keeps the first name for a repeated address', () => {
    expect(
      extraRecipients([
        { address: ' Ann@X.com ', name: 'Ann' },
        { address: 'ann@x.com', name: 'Other' },
        { address: '' },
        { address: 'nope' },
        { address: 'bo@x.com' },
      ])
    ).toEqual([
      { address: 'Ann@X.com', name: 'Ann' },
      { address: 'bo@x.com', name: null },
    ]);
  });
});
