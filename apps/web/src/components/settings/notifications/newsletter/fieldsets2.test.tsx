import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Destination, NewsletterRecipientsView, Settings } from '@tracearr/shared';
import { defaultFormState, type NewsletterFormState } from './newsletterForm';
import { RecipientsFields } from './RecipientsFields';
import { DeliveryFields } from './DeliveryFields';
import { LinksFields } from './LinksFields';
import { ReadinessList, readinessChecks } from './ReadinessList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
      <MemoryRouter>
        <RecipientsFields {...p} newsletterId={null} />
      </MemoryRouter>
    );
    await userEvent.click(
      screen.getByRole('switch', { name: 'newsletters.editor.recipients.members' })
    );
    expect(p.onChange).toHaveBeenCalledWith({
      recipients: { ...p.state.recipients, members: false },
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.addAddress' })
    );
    expect(p.onChange).toHaveBeenCalledWith({
      recipients: { ...p.state.recipients, extraAddresses: [{ address: '' }] },
    });

    rerender(
      <MemoryRouter>
        <RecipientsFields
          {...p}
          newsletterId={null}
          state={{
            ...p.state,
            recipients: { ...p.state.recipients, extraAddresses: [{ address: 'nope' }] },
          }}
        />
      </MemoryRouter>
    );
    expect(screen.getByRole('alert')).toHaveTextContent('newsletters.editor.recipients.badAddress');
    await userEvent.type(
      screen.getByLabelText('newsletters.editor.recipients.addressLabel:{"n":1}'),
      'x'
    );
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
      <MemoryRouter>
        <RecipientsFields {...p} newsletterId="n-1" />
      </MemoryRouter>
    );

    // Dee starts server-excluded but not locally excluded, so her "included after save" bucket must offer the same Exclude action a normal recipient gets.
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.exclude:{"name":"Dee"}' })
    );
    expect(p.onChange).toHaveBeenLastCalledWith({
      recipients: { ...p.state.recipients, excludeUserIds: ['u4'] },
    });

    rerender(
      <MemoryRouter>
        <RecipientsFields
          {...p}
          newsletterId="n-1"
          state={{ ...p.state, recipients: { ...p.state.recipients, excludeUserIds: ['u4'] } }}
        />
      </MemoryRouter>
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
      <MemoryRouter>
        <RecipientsFields
          {...p}
          newsletterId="n-1"
          state={{ ...p.state, recipients: { ...p.state.recipients, excludeUserIds: [] } }}
        />
      </MemoryRouter>
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
      <MemoryRouter>
        <DeliveryFields {...p} />
      </MemoryRouter>
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
});

describe('LinksFields', () => {
  it('toggles the tracearr links switch, off by default, with the admin-only note', async () => {
    const p = props();
    render(<LinksFields {...p} />);
    const toggle = screen.getByRole('switch', { name: 'newsletters.editor.links.tracearr' });
    expect(toggle).not.toBeChecked();
    expect(screen.getByText('newsletters.editor.links.tracearrNote')).toBeInTheDocument();
    await userEvent.click(toggle);
    expect(p.onChange).toHaveBeenCalledWith({ links: { tracearr: true } });
  });
});

describe('readiness', () => {
  it('evaluates the checks, warns on an http external url, and lists each private Jellyfin or Emby server', () => {
    const checks = readinessChecks({
      externalUrl: 'https://tracearr.example.com',
      destination: email,
      recipients: { resolvable: 2, known: true },
      servers: [],
    });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['externalUrl', 'pass'],
      ['fromDomain', 'pass'],
      ['recipients', 'pass'],
      ['dns', 'info'],
    ]);
    const bad = readinessChecks({
      externalUrl: null,
      destination: {
        ...email,
        config: { fromAddress: 'news@example.com', username: 'bot@other.com' },
      } as unknown as Destination,
      recipients: { resolvable: 0, known: false },
      servers: [],
    });
    expect(bad.map((c) => c.status)).toEqual(['fail', 'fail', 'unknown', 'info']);
    const insecure = readinessChecks({
      externalUrl: 'http://tracearr.example.com',
      destination: {
        ...email,
        config: { fromAddress: 'news@example.com', username: 'apikey' },
      } as unknown as Destination,
      recipients: { resolvable: 0, known: true },
      servers: [
        { name: 'Attic', type: 'jellyfin', url: 'http://192.168.1.20:8096', publicUrl: null },
        { name: 'Basement', type: 'plex', url: 'http://192.168.1.10:32400', publicUrl: null },
        { name: 'Shed', type: 'emby', url: 'https://emby.example.com', publicUrl: null },
      ],
    });
    expect(
      insecure.map((c) => (c.id === 'privateServer' ? [c.id, c.server] : [c.id, c.status]))
    ).toEqual([
      ['externalUrl', 'warn'],
      ['fromDomain', 'pass'],
      ['recipients', 'fail'],
      ['privateServer', 'Attic'],
      ['dns', 'info'],
    ]);
  });

  it('names the reason a Jellyfin or Emby server has no member link and skips the ones that do', () => {
    const rows = readinessChecks({
      externalUrl: 'https://tracearr.example.com',
      destination: email,
      recipients: { resolvable: 2, known: true },
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
      <MemoryRouter>
        <ReadinessList
          state={{
            ...defaultFormState(),
            destinationId: 'd-1',
            scope: { serverIds: ['s-2'], libraries: [] },
          }}
          newsletterId={null}
        />
      </MemoryRouter>
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

  it('renders one row per check with the docs link', () => {
    render(
      <MemoryRouter>
        <ReadinessList
          state={{ ...defaultFormState(), destinationId: 'd-1' }}
          newsletterId={null}
        />
      </MemoryRouter>
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(4);
    expect(
      screen.getByRole('link', { name: 'newsletters.editor.readiness.dnsLink' })
    ).toHaveAttribute('href', 'https://docs.tracearr.com/configuration/email#spf-dkim-and-dmarc');
    expect(screen.getByText('newsletters.editor.readiness.recipientsUnknown')).toBeInTheDocument();
  });

  it('says recipients failed to load in edit mode instead of unknown-until-saved', () => {
    vi.mocked(useNewsletterRecipients).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useNewsletterRecipients>);
    render(
      <MemoryRouter>
        <ReadinessList state={{ ...defaultFormState(), destinationId: 'd-1' }} newsletterId="n-1" />
      </MemoryRouter>
    );
    expect(
      screen.getByText('newsletters.editor.readiness.recipientsLoadFailed')
    ).toBeInTheDocument();
    expect(
      screen.queryByText('newsletters.editor.readiness.recipientsUnknown')
    ).not.toBeInTheDocument();
  });
});
