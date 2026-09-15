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
}));
import { useDestinations, useNewsletterRecipients, useServers, useSettings } from '@/hooks/queries';

let queryClient: QueryClient;

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

const dee = {
  userId: 'u4',
  serverUserId: 'su-4',
  name: 'Dee',
  username: 'dee',
  serverId: 's1',
  serverName: 'Home Plex',
  serverIds: ['s1'],
  thumbUrl: null,
};

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

function mockRecipients(data: NewsletterRecipientsView | undefined) {
  vi.mocked(useNewsletterRecipients).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useNewsletterRecipients>);
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
  mockRecipients(undefined);
  vi.mocked(useServers).mockReturnValue({ data: [] } as unknown as ReturnType<typeof useServers>);
});

describe('RecipientsFields', () => {
  it('toggles members, keeps extra addresses folded away until opened, and edits a row', async () => {
    const p = props();
    const { rerender } = render(
      <Providers>
        <RecipientsFields {...p} newsletterId={null} savedExcludeUserIds={[]} />
      </Providers>
    );
    await userEvent.click(
      screen.getByRole('switch', { name: 'newsletters.editor.recipients.members' })
    );
    expect(p.onChange).toHaveBeenCalledWith({
      recipients: { ...p.state.recipients, members: false },
    });
    expect(p.touch).toHaveBeenCalledWith('recipients');

    const trigger = screen.getByRole('button', {
      name: 'newsletters.editor.recipients.extraTrigger:{"count":0}',
    });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(trigger);
    expect(screen.getByText('newsletters.editor.recipients.extraHelp')).toBeInTheDocument();

    rerender(
      <Providers>
        <RecipientsFields
          {...p}
          newsletterId={null}
          savedExcludeUserIds={[]}
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

  it('adds pasted addresses once each, skips ones already listed, and flags a bad one at once', async () => {
    const listed = { members: true, extraAddresses: [{ address: 'A@x.com' }], excludeUserIds: [] };
    const p = props({ recipients: listed });
    const { rerender } = render(
      <Providers>
        <RecipientsFields {...p} newsletterId={null} savedExcludeUserIds={[]} />
      </Providers>
    );
    const box = screen.getByRole('textbox', {
      name: 'newsletters.editor.recipients.pasteAddresses',
    });
    await userEvent.type(box, 'a@x.com{enter}b@x.com, b@x.com{enter}nope');
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.add' }));
    const added = [{ address: 'A@x.com' }, { address: 'b@x.com' }, { address: 'nope' }];
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...listed, extraAddresses: added },
    });
    expect(box).toHaveValue('');

    rerender(
      <Providers>
        <RecipientsFields
          {...p}
          newsletterId={null}
          savedExcludeUserIds={[]}
          state={{ ...p.state, recipients: { ...listed, extraAddresses: added } }}
        />
      </Providers>
    );
    expect(screen.getAllByText('newsletters.editor.recipients.badAddress')).toHaveLength(1);
  });

  it('opens extra addresses when the form reports a recipients error', () => {
    const p = props();
    render(
      <Providers>
        <RecipientsFields
          {...p}
          errors={{ recipients: 'Too many addresses' }}
          newsletterId={null}
          savedExcludeUserIds={[]}
        />
      </Providers>
    );
    expect(screen.getByText('Too many addresses')).toBeInTheDocument();
  });

  it('calls an address bad only once the field has been left', async () => {
    const p = props({
      recipients: { members: true, extraAddresses: [{ address: '' }], excludeUserIds: [] },
    });
    const { rerender } = render(
      <Providers>
        <RecipientsFields {...p} newsletterId={null} savedExcludeUserIds={[]} />
      </Providers>
    );
    const input = screen.getByLabelText('newsletters.editor.recipients.addressLabel:{"n":1}');
    await userEvent.type(input, 'someone@');
    rerender(
      <Providers>
        <RecipientsFields
          {...p}
          newsletterId={null}
          savedExcludeUserIds={[]}
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
        <RecipientsFields {...p} newsletterId={null} savedExcludeUserIds={[]} />
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
          savedExcludeUserIds={[]}
          state={{
            ...p.state,
            recipients: { ...p.state.recipients, extraAddresses: [{ address: 'b@x.com' }] },
          }}
        />
      </Providers>
    );
    expect(screen.getByDisplayValue('b@x.com')).toBe(second);
  });

  it('names the chosen servers in the members help', () => {
    vi.mocked(useServers).mockReturnValue({
      data: [
        { id: 's-1', name: 'Basement' },
        { id: 's-2', name: 'Attic' },
      ],
    } as unknown as ReturnType<typeof useServers>);
    const p = props({ scope: { serverIds: ['s-2'], libraries: [] } });
    render(
      <Providers>
        <RecipientsFields {...p} newsletterId="n-1" savedExcludeUserIds={[]} />
      </Providers>
    );
    expect(
      screen.getByText('newsletters.editor.recipients.membersHelp:{"servers":"Attic"}')
    ).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.recipients.ownerNote')).toBeInTheDocument();
  });

  it('excludes a person and includes them back, patching recipients each time', async () => {
    mockRecipients({
      recipients: [
        {
          ...dee,
          address: 'dee@x.com',
          suppressed: false,
          newSinceLastSend: true,
          addressFromUsername: false,
        },
      ],
      missing: [],
      excluded: [],
    });
    const p = props();
    const { rerender } = render(
      <Providers>
        <RecipientsFields {...p} newsletterId="n-1" savedExcludeUserIds={[]} />
      </Providers>
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.exclude:{"name":"Dee"}' })
    );
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...p.state.recipients, excludeUserIds: ['u4'] },
    });

    mockRecipients({ recipients: [], missing: [], excluded: [{ ...dee, reason: 'excluded' }] });
    rerender(
      <Providers>
        <RecipientsFields
          {...p}
          newsletterId="n-1"
          savedExcludeUserIds={[]}
          state={{ ...p.state, recipients: { ...p.state.recipients, excludeUserIds: ['u4'] } }}
        />
      </Providers>
    );
    expect(screen.getByRole('listitem', { name: 'Dee' })).toHaveTextContent(
      'newsletters.editor.recipients.excludedAfterSave'
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.include:{"name":"Dee"}' })
    );
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...p.state.recipients, excludeUserIds: [] },
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
