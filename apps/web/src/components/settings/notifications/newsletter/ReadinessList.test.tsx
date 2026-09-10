import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Destination, NewsletterRecipientsView, Settings } from '@tracearr/shared';
import { defaultFormState } from './newsletterForm';
import { ReadinessList, readinessChecks } from './ReadinessList';
import { RecipientsPanel } from './RecipientsPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/hooks/queries', () => ({
  useDestinations: vi.fn(),
  useSettings: vi.fn(),
  useNewsletterRecipients: vi.fn(),
  useServers: vi.fn(),
  useNewsletterVariants: vi.fn(),
  useUpdateUserIdentity: () => ({ mutate: vi.fn(), isPending: false }),
  newsletterKeys: { recipients: (id: string) => ['newsletters', id, 'recipients'] },
}));
import {
  useDestinations,
  useNewsletterRecipients,
  useNewsletterVariants,
  useServers,
  useSettings,
} from '@/hooks/queries';

let queryClient: QueryClient;

/** RecipientsPanel reads the query cache directly, so anything that can render it needs a real client. */
function Providers({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

const email = {
  id: 'd-1',
  name: 'Postmark',
  type: 'email',
  enabled: true,
  config: { fromAddress: 'news@example.com', username: 'apikey@example.com' },
} as unknown as Destination;

const twoExtras = {
  members: false as const,
  extraAddresses: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
  excludeUserIds: [],
};
const noExtras = { members: false as const, extraAddresses: [], excludeUserIds: [] };
const membersUnresolved = { members: true as const, extraAddresses: [], excludeUserIds: [] };

const settled = {
  variants: undefined,
  variantsError: false,
  externalUrl: 'https://tracearr.example.com',
  destinationId: 'd-1',
  destination: email,
  destinationsError: false,
  servers: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(useDestinations).mockReturnValue({ data: [email] } as unknown as ReturnType<
    typeof useDestinations
  >);
  vi.mocked(useSettings).mockReturnValue({
    data: { externalUrl: 'https://tracearr.example.com' } as Settings,
  } as unknown as ReturnType<typeof useSettings>);
  vi.mocked(useNewsletterRecipients).mockReturnValue({
    data: undefined,
    isLoading: false,
  } as unknown as ReturnType<typeof useNewsletterRecipients>);
  vi.mocked(useServers).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useServers>);
  vi.mocked(useNewsletterVariants).mockReturnValue({
    data: undefined,
    isError: false,
  } as unknown as ReturnType<typeof useNewsletterVariants>);
});

describe('readinessChecks', () => {
  it('evaluates every check, puts failures first, then warnings, then unknowns', () => {
    const good = readinessChecks({ ...settled, recipients: { form: twoExtras, view: undefined } });
    expect(good.map((c) => [c.id, c.status])).toEqual([
      ['destination', 'pass'],
      ['externalUrl', 'pass'],
      ['fromDomain', 'pass'],
      ['recipients', 'pass'],
      ['dns', 'info'],
    ]);

    const bad = readinessChecks({
      ...settled,
      externalUrl: null,
      destination: {
        ...email,
        config: { fromAddress: 'news@example.com', username: 'bot@other.com' },
      } as unknown as Destination,
      recipients: { form: membersUnresolved, view: undefined },
    });
    expect(bad.map((c) => [c.id, c.status])).toEqual([
      ['externalUrl', 'fail'],
      ['fromDomain', 'fail'],
      ['recipients', 'unknown'],
      ['destination', 'pass'],
      ['dns', 'info'],
    ]);

    const insecure = readinessChecks({
      ...settled,
      externalUrl: 'http://tracearr.example.com',
      destination: {
        ...email,
        config: { fromAddress: 'news@example.com', username: 'apikey' },
      } as unknown as Destination,
      recipients: { form: noExtras, view: undefined },
      servers: [
        { name: 'Attic', type: 'jellyfin', url: 'http://192.168.1.20:8096', publicUrl: null },
        { name: 'Basement', type: 'plex', url: 'http://192.168.1.10:32400', publicUrl: null },
        { name: 'Shed', type: 'emby', url: 'https://emby.example.com', publicUrl: null },
      ],
    });
    expect(
      insecure.map((c) => (c.id === 'privateServer' ? [c.id, c.server] : [c.id, c.status]))
    ).toEqual([
      ['recipients', 'fail'],
      ['externalUrl', 'warn'],
      ['privateServer', 'Attic'],
      ['destination', 'pass'],
      ['fromDomain', 'pass'],
      ['dns', 'info'],
    ]);
  });

  it('fails the destination when none is chosen and holds it unknown while the chosen one has not loaded', () => {
    const none = readinessChecks({
      ...settled,
      destinationId: null,
      destination: null,
      recipients: { form: twoExtras, view: undefined },
    });
    expect(none[0]).toEqual({ id: 'destination', status: 'fail', name: null });
    const loading = readinessChecks({
      ...settled,
      destination: null,
      recipients: { form: twoExtras, view: undefined },
    });
    expect(loading.find((c) => c.id === 'destination')).toEqual({
      id: 'destination',
      status: 'unknown',
      name: null,
    });
    expect(loading.find((c) => c.id === 'fromDomain')?.status).toBe('unknown');
  });

  it('agrees with the panel: members off with no extras resolves to zero, and an unsaved exclusion drops the count', () => {
    const recipientsCheck = (checks: ReturnType<typeof readinessChecks>) =>
      checks.find((c) => c.id === 'recipients');

    expect(
      recipientsCheck(
        readinessChecks({ ...settled, recipients: { form: noExtras, view: undefined } })
      )
    ).toEqual({ id: 'recipients', status: 'fail', count: 0 });

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
      ],
      missing: [],
      excluded: [],
    };
    expect(
      recipientsCheck(
        readinessChecks({
          ...settled,
          recipients: { form: { members: true, extraAddresses: [], excludeUserIds: [] }, view },
        })
      )
    ).toEqual({ id: 'recipients', status: 'pass', count: 1 });

    expect(
      recipientsCheck(
        readinessChecks({
          ...settled,
          recipients: { form: { members: true, extraAddresses: [], excludeUserIds: ['u1'] }, view },
        })
      )
    ).toEqual({ id: 'recipients', status: 'fail', count: 0 });
  });

  it('names the reason a Jellyfin or Emby server has no member link and skips the ones that do', () => {
    const rows = readinessChecks({
      ...settled,
      recipients: { form: twoExtras, view: undefined },
      servers: [
        { name: 'Attic', type: 'jellyfin', url: 'http://192.168.1.20:8096', publicUrl: null },
        {
          name: 'Shed',
          type: 'emby',
          url: 'https://emby.example.com',
          publicUrl: 'http://10.0.0.5:8096',
        },
        {
          name: 'Loft',
          type: 'jellyfin',
          url: 'http://192.168.1.21:8096',
          publicUrl: 'https://loft.example.com',
        },
        { name: 'Porch', type: 'emby', url: 'https://porch.example.com', publicUrl: null },
        { name: 'Basement', type: 'plex', url: 'http://192.168.1.10:32400', publicUrl: null },
      ],
    }).flatMap((c) => (c.id === 'privateServer' ? [[c.server, c.reason]] : []));
    expect(rows).toEqual([
      ['Attic', 'noPublicUrl'],
      ['Shed', 'privatePublicUrl'],
    ]);
  });

  it('warns once per variant with nothing new when there are several, and never for a single one', () => {
    const view = {
      window: { start: '2026-08-28T00:00:00.000Z', end: '2026-09-04T00:00:00.000Z' },
      variants: [
        {
          key: 's-1,s-2',
          serverIds: ['s-1', 's-2'],
          serverNames: ['Attic', 'Basement'],
          recipientCount: 1,
          counts: {},
          isEmpty: false,
        },
        {
          key: 's-2',
          serverIds: ['s-2'],
          serverNames: ['Attic'],
          recipientCount: 4,
          counts: {},
          isEmpty: true,
        },
      ],
    };
    const rows = readinessChecks({
      ...settled,
      recipients: { form: twoExtras, view: undefined },
      variants: view,
    });
    expect(rows.filter((c) => c.id === 'emptyVariant')).toEqual([
      { id: 'emptyVariant', status: 'warn', servers: ['Attic'] },
    ]);
    const single = readinessChecks({
      ...settled,
      recipients: { form: twoExtras, view: undefined },
      variants: { ...view, variants: [{ ...view.variants[1]! }] },
    });
    expect(single.some((c) => c.id === 'emptyVariant')).toBe(false);
  });
});

describe('ReadinessList', () => {
  it('renders one row per check, names the destination, counts the recipients, and links the docs', () => {
    render(
      <Providers>
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1', recipients: twoExtras }}
          newsletterId={null}
          savedServerIds={null}
        />
      </Providers>
    );
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toEqual([
      'newsletters.editor.readiness.destination:{"name":"Postmark"}',
      'newsletters.editor.readiness.externalUrl',
      'newsletters.editor.readiness.fromDomain',
      'newsletters.editor.readiness.recipients:{"count":2}',
      'newsletters.editor.readiness.dns newsletters.editor.readiness.dnsLink',
    ]);
    expect(
      screen.getByRole('link', { name: 'newsletters.editor.readiness.dnsLink' })
    ).toHaveAttribute('href', 'https://docs.tracearr.com/configuration/email#spf-dkim-and-dmarc');
    expect(screen.getByText('newsletters.editor.readiness.intro')).toBeInTheDocument();
  });

  it('puts a missing destination first with a button that focuses the select', async () => {
    render(
      <Providers>
        <input id="newsletter-destination" aria-label="destination" />
        <ReadinessList
          state={{ ...defaultFormState(), recipients: twoExtras }}
          newsletterId={null}
          savedServerIds={null}
        />
      </Providers>
    );
    const first = screen.getAllByRole('listitem')[0];
    expect(first).toHaveTextContent('newsletters.editor.readiness.destinationFail');
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.readiness.fixDestination' })
    );
    expect(screen.getByLabelText('destination')).toHaveFocus();
  });

  it('scrolls the delivery card into view when there is no destination select to focus', async () => {
    render(
      <Providers>
        <section id="newsletter-delivery" />
        <ReadinessList
          state={{ ...defaultFormState(), recipients: twoExtras }}
          newsletterId={null}
          savedServerIds={null}
        />
      </Providers>
    );
    const card = document.getElementById('newsletter-delivery')!;
    const scroll = vi.spyOn(card, 'scrollIntoView');
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.readiness.fixDestination' })
    );
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
  });

  it('says the destinations could not be loaded instead of checking them forever', () => {
    vi.mocked(useDestinations).mockReturnValue({
      data: undefined,
      isError: true,
    } as unknown as ReturnType<typeof useDestinations>);
    render(
      <Providers>
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1', recipients: twoExtras }}
          newsletterId={null}
          savedServerIds={null}
        />
      </Providers>
    );
    const first = screen.getAllByRole('listitem')[0];
    expect(first).toHaveTextContent('newsletters.editor.readiness.destinationError');
    expect(
      screen.queryByText('newsletters.editor.readiness.destinationUnknown')
    ).not.toBeInTheDocument();
  });

  it('counts a person included after save the same way the recipients card heads its list', () => {
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
      ],
      missing: [],
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
      ],
    };
    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: view,
      isLoading: false,
      isError: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    const recipients = { members: true as const, extraAddresses: [], excludeUserIds: [] };
    render(
      <Providers>
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1', recipients }}
          newsletterId="n-1"
          savedServerIds={[]}
        />
        <RecipientsPanel
          newsletterId="n-1"
          recipients={recipients}
          onExclude={vi.fn()}
          onInclude={vi.fn()}
          servers={[{ id: 's1', name: 'Home Plex' }]}
          staleScope={false}
          onPreview={vi.fn()}
        />
      </Providers>
    );
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toContain('newsletters.editor.readiness.recipients:{"count":2}');
    expect(
      screen.getByText('newsletters.editor.recipients.willReceive:{"count":2}')
    ).toBeInTheDocument();
  });

  it('offers the way to the recipients card and to remote access when those checks fail', async () => {
    vi.mocked(useSettings).mockReturnValue({
      data: { externalUrl: null } as Settings,
    } as unknown as ReturnType<typeof useSettings>);
    render(
      <Providers>
        <section id="newsletter-recipients" />
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1', recipients: noExtras }}
          newsletterId={null}
          savedServerIds={null}
        />
      </Providers>
    );
    const card = document.getElementById('newsletter-recipients')!;
    const scroll = vi.spyOn(card, 'scrollIntoView');
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.readiness.fixRecipients' })
    );
    expect(scroll).toHaveBeenCalledWith({ block: 'start', behavior: 'smooth' });
    expect(
      screen.getByRole('link', { name: 'newsletters.editor.readiness.fixExternalUrl' })
    ).toHaveAttribute('href', '/settings/access/remote');
    expect(screen.getByText('newsletters.editor.readiness.recipientsFail')).toBeInTheDocument();
  });

  it('renders each in-scope private server row with its reason and a link to the server settings', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [
        {
          id: 's-1',
          name: 'Attic',
          type: 'jellyfin',
          url: 'http://192.168.1.20:8096',
          publicUrl: null,
        },
        {
          id: 's-2',
          name: 'Shed',
          type: 'emby',
          url: 'https://emby.example.com',
          publicUrl: 'http://10.0.0.5:8096',
        },
      ],
    } as unknown as ReturnType<typeof useServers>);
    render(
      <Providers>
        <ReadinessList
          state={{
            ...defaultFormState(),
            destinationId: 'd-1',
            scope: { serverIds: ['s-2'], libraries: [] },
          }}
          newsletterId={null}
          savedServerIds={null}
        />
      </Providers>
    );
    const rows = screen.getAllByRole('listitem').map((li) => li.textContent);
    expect(rows).toContain(
      'newsletters.editor.readiness.privatePublicUrl:{"server":"Shed"} newsletters.editor.readiness.serverSettingsLink'
    );
    expect(rows.join('\n')).not.toContain('"server":"Attic"');
    expect(
      screen.getByRole('link', { name: 'newsletters.editor.readiness.serverSettingsLink' })
    ).toHaveAttribute('href', '/settings/servers/connections');
  });

  it('says recipients are unknown until saved, and failed to load in edit mode', () => {
    const { unmount } = render(
      <Providers>
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1' }}
          newsletterId={null}
          savedServerIds={null}
        />
      </Providers>
    );
    expect(screen.getByText('newsletters.editor.readiness.recipientsUnknown')).toBeInTheDocument();
    unmount();

    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    render(
      <Providers>
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1' }}
          newsletterId="n-1"
          savedServerIds={[]}
        />
      </Providers>
    );
    expect(
      screen.getByText('newsletters.editor.readiness.recipientsLoadFailed')
    ).toBeInTheDocument();
    expect(
      screen.queryByText('newsletters.editor.readiness.recipientsUnknown')
    ).not.toBeInTheDocument();
  });

  it('says variant counts failed to load when the variants query errors', () => {
    vi.mocked(useNewsletterVariants).mockReturnValue({
      data: undefined,
      isError: true,
    } as unknown as ReturnType<typeof useNewsletterVariants>);
    render(
      <Providers>
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1' }}
          newsletterId="n-1"
          savedServerIds={[]}
        />
      </Providers>
    );
    expect(screen.getByText('newsletters.editor.readiness.variantsLoadFailed')).toBeInTheDocument();
  });

  it('never asks the server for recipients when Members is off, and fails readiness with nothing typed', () => {
    render(
      <Providers>
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1', recipients: noExtras }}
          newsletterId="n-1"
          savedServerIds={[]}
        />
      </Providers>
    );
    expect(useNewsletterRecipients).toHaveBeenCalledWith(undefined);
    expect(screen.getByText('newsletters.editor.readiness.recipientsFail')).toBeInTheDocument();
  });

  it('renders the empty-variant row with the server names joined', () => {
    vi.mocked(useNewsletterVariants).mockReturnValue({
      data: {
        window: { start: '2026-08-28T00:00:00.000Z', end: '2026-09-04T00:00:00.000Z' },
        variants: [
          {
            key: 's-1,s-2',
            serverIds: ['s-1', 's-2'],
            serverNames: ['Attic', 'Basement'],
            recipientCount: 0,
            counts: {},
            isEmpty: false,
          },
          {
            key: 's-1',
            serverIds: ['s-1'],
            serverNames: ['Basement'],
            recipientCount: 2,
            counts: {},
            isEmpty: true,
          },
        ],
      },
    } as unknown as ReturnType<typeof useNewsletterVariants>);
    render(
      <Providers>
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1' }}
          newsletterId="n-1"
          savedServerIds={[]}
        />
      </Providers>
    );
    expect(useNewsletterVariants).toHaveBeenCalledWith('n-1');
    expect(
      screen.getByText('newsletters.editor.readiness.emptyVariant:{"servers":"Basement"}')
    ).toBeInTheDocument();
  });

  it('says the rows reflect the saved servers once the scope moves', () => {
    const { rerender } = render(
      <Providers>
        <ReadinessList
          state={{
            ...defaultFormState(),
            destinationId: 'd-1',
            scope: { serverIds: ['s-2'], libraries: [] },
          }}
          newsletterId="n-1"
          savedServerIds={['s-1']}
        />
      </Providers>
    );
    expect(screen.getByText('newsletters.editor.readiness.staleScope')).toBeInTheDocument();
    rerender(
      <Providers>
        <ReadinessList
          state={{
            ...defaultFormState(),
            destinationId: 'd-1',
            scope: { serverIds: ['s-2'], libraries: [] },
          }}
          newsletterId="n-1"
          savedServerIds={['s-2']}
        />
      </Providers>
    );
    expect(screen.queryByText('newsletters.editor.readiness.staleScope')).not.toBeInTheDocument();
  });
});
