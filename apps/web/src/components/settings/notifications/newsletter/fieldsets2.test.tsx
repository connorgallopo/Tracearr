import type { ReactNode } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Destination, NewsletterRecipientsView, Settings } from '@tracearr/shared';
import { defaultFormState, type NewsletterFormState } from './newsletterForm';
import { RecipientsFields } from './RecipientsFields';
import { DeliveryFields } from './DeliveryFields';

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
  useUpdateUserIdentity: () => ({ mutate: vi.fn(), isPending: false }),
  newsletterKeys: { recipients: (id: string) => ['newsletters', id, 'recipients'] },
}));
import { useDestinations, useNewsletterRecipients, useServers, useSettings } from '@/hooks/queries';

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
const discord = {
  id: 'd-2',
  name: 'Discord',
  type: 'discord',
  enabled: true,
  config: {},
} as unknown as Destination;

function props(over: Partial<NewsletterFormState> = {}) {
  const onChange = vi.fn();
  return {
    state: { ...defaultFormState(), ...over },
    onChange,
    errors: {},
    mode: 'create' as const,
    touch: vi.fn(),
    touched: {},
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(useDestinations).mockReturnValue({ data: [email, discord] } as unknown as ReturnType<
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
});

describe('RecipientsFields', () => {
  it('toggles members and edits extra addresses row by row', async () => {
    const p = props();
    const { rerender } = render(
      <Providers>
        <RecipientsFields {...p} newsletterId={null} savedServerIds={null} onPreview={vi.fn()} />
      </Providers>
    );
    await userEvent.click(
      screen.getByRole('switch', { name: 'newsletters.editor.recipients.members' })
    );
    expect(p.onChange).toHaveBeenCalledWith({
      recipients: { ...p.state.recipients, members: false },
    });
    expect(p.touch).toHaveBeenCalledWith('recipients');

    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.addAddress' })
    );
    expect(p.onChange).toHaveBeenCalledWith({
      recipients: { ...p.state.recipients, extraAddresses: [{ address: '' }] },
    });

    rerender(
      <Providers>
        <RecipientsFields
          {...p}
          newsletterId={null}
          savedServerIds={null}
          onPreview={vi.fn()}
          state={{
            ...p.state,
            recipients: { ...p.state.recipients, extraAddresses: [{ address: 'nope' }] },
          }}
        />
      </Providers>
    );
    const first = screen.getByLabelText('newsletters.editor.recipients.addressLabel:{"n":1}');
    await userEvent.click(first);
    await userEvent.tab();
    expect(screen.getByRole('alert')).toHaveTextContent('newsletters.editor.recipients.badAddress');
    await userEvent.type(first, 'x');
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...p.state.recipients, extraAddresses: [{ address: 'nopex' }] },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.removeAddress:{"n":1}' })
    );
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...p.state.recipients, extraAddresses: [] },
    });
  });

  it('calls an address bad only once the field has been left', async () => {
    const p = props({
      recipients: { members: true, extraAddresses: [{ address: '' }], excludeUserIds: [] },
    });
    const { rerender } = render(
      <Providers>
        <RecipientsFields {...p} newsletterId={null} savedServerIds={null} onPreview={vi.fn()} />
      </Providers>
    );
    const input = screen.getByLabelText('newsletters.editor.recipients.addressLabel:{"n":1}');
    await userEvent.type(input, 'someone@');
    rerender(
      <Providers>
        <RecipientsFields
          {...p}
          newsletterId={null}
          savedServerIds={null}
          onPreview={vi.fn()}
          state={{
            ...p.state,
            recipients: { ...p.state.recipients, extraAddresses: [{ address: 'someone@' }] },
          }}
        />
      </Providers>
    );
    expect(screen.queryByText('newsletters.editor.recipients.badAddress')).not.toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'false');

    await userEvent.tab();
    expect(screen.getByText('newsletters.editor.recipients.badAddress')).toBeInTheDocument();
    expect(input).toHaveAttribute('aria-invalid', 'true');
  });

  it("keeps the surviving row's input when the row above it is removed", async () => {
    const p = props({
      recipients: {
        members: true,
        extraAddresses: [{ address: 'a@x.com' }, { address: 'b@x.com' }],
        excludeUserIds: [],
      },
    });
    const { rerender } = render(
      <Providers>
        <RecipientsFields {...p} newsletterId={null} savedServerIds={null} onPreview={vi.fn()} />
      </Providers>
    );
    const second = screen.getByDisplayValue('b@x.com');
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.removeAddress:{"n":1}' })
    );
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...p.state.recipients, extraAddresses: [{ address: 'b@x.com' }] },
    });
    rerender(
      <Providers>
        <RecipientsFields
          {...p}
          newsletterId={null}
          savedServerIds={null}
          onPreview={vi.fn()}
          state={{
            ...p.state,
            recipients: { ...p.state.recipients, extraAddresses: [{ address: 'b@x.com' }] },
          }}
        />
      </Providers>
    );
    expect(screen.getByDisplayValue('b@x.com')).toBe(second);
  });

  it('names the chosen servers in the members help, says what an extra address gets, and flags a moved scope', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [
        { id: 's-1', name: 'Basement' },
        { id: 's-2', name: 'Attic' },
      ],
    } as unknown as ReturnType<typeof useServers>);
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
            serverId: 's-1',
            serverName: 'Basement',
            serverIds: ['s-1'],
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
    const p = props({ scope: { serverIds: ['s-2'], libraries: [] } });
    const { rerender } = render(
      <Providers>
        <RecipientsFields {...p} newsletterId="n-1" savedServerIds={['s-1']} onPreview={vi.fn()} />
      </Providers>
    );
    expect(
      screen.getByText('newsletters.editor.recipients.membersHelp:{"servers":"Attic"}')
    ).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.recipients.ownerNote')).toBeInTheDocument();
    expect(
      screen.getByText('newsletters.editor.recipients.extraAddressesHelp')
    ).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.recipients.staleScope')).toBeInTheDocument();

    rerender(
      <Providers>
        <RecipientsFields {...p} newsletterId="n-1" savedServerIds={['s-2']} onPreview={vi.fn()} />
      </Providers>
    );
    expect(screen.queryByText('newsletters.editor.recipients.staleScope')).not.toBeInTheDocument();
  });

  it('excludes, includes, and excludes a person again, patching recipients each time', async () => {
    const view: NewsletterRecipientsView = {
      recipients: [],
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
    const p = props();
    const { rerender } = render(
      <Providers>
        <RecipientsFields {...p} newsletterId="n-1" savedServerIds={[]} onPreview={vi.fn()} />
      </Providers>
    );

    // Dee starts server-excluded but not locally excluded, so her "included after save" bucket must offer the same Exclude action a normal recipient gets.
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.exclude:{"name":"Dee"}' })
    );
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...p.state.recipients, excludeUserIds: ['u4'] },
    });

    rerender(
      <Providers>
        <RecipientsFields
          {...p}
          newsletterId="n-1"
          savedServerIds={[]}
          onPreview={vi.fn()}
          state={{ ...p.state, recipients: { ...p.state.recipients, excludeUserIds: ['u4'] } }}
        />
      </Providers>
    );
    await userEvent.click(
      screen.getByRole('button', {
        name: 'newsletters.editor.recipients.excludedCount:{"count":1}',
      })
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.include:{"name":"Dee"}' })
    );
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...p.state.recipients, excludeUserIds: [] },
    });

    rerender(
      <Providers>
        <RecipientsFields
          {...p}
          newsletterId="n-1"
          savedServerIds={[]}
          onPreview={vi.fn()}
          state={{ ...p.state, recipients: { ...p.state.recipients, excludeUserIds: [] } }}
        />
      </Providers>
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.exclude:{"name":"Dee"}' })
    );
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...p.state.recipients, excludeUserIds: ['u4'] },
    });
  });
});

describe('DeliveryFields', () => {
  it('offers only email destinations, warns on hosted without an external url, and toggles skip', async () => {
    vi.mocked(useSettings).mockReturnValue({
      data: { externalUrl: null } as Settings,
    } as unknown as ReturnType<typeof useSettings>);
    const p = props({ imageMode: 'hosted' });
    render(
      <Providers>
        <DeliveryFields {...p} />
      </Providers>
    );
    await userEvent.click(
      screen.getByRole('combobox', { name: 'newsletters.editor.delivery.destination' })
    );
    expect(screen.getByRole('option', { name: 'Postmark' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Discord' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('option', { name: 'Postmark' }));
    expect(p.onChange).toHaveBeenCalledWith({ destinationId: 'd-1' });
    expect(screen.getByRole('alert')).toHaveTextContent(
      'newsletters.editor.delivery.hostedNeedsUrl'
    );
    await userEvent.click(
      screen.getByRole('switch', { name: 'newsletters.editor.delivery.skipWhenEmpty' })
    );
    expect(p.onChange).toHaveBeenCalledWith({ skipWhenEmpty: false });
  });

  it('carries the tracearr links switch as its last row, off by default, with the admin-only note', async () => {
    const p = props();
    render(
      <Providers>
        <DeliveryFields {...p} />
      </Providers>
    );
    const toggle = screen.getByRole('switch', { name: 'newsletters.editor.links.tracearr' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('newsletters.editor.links.tracearrNote')).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(p.onChange).toHaveBeenCalledWith({ links: { tracearr: true } });
  });
});
