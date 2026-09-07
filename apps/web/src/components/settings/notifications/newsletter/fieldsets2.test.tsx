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
  useUpdateUserIdentity: () => ({ mutate: vi.fn(), isPending: false }),
}));
import { useDestinations, useNewsletterRecipients, useSettings } from '@/hooks/queries';

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
      excluded: [{ userId: 'u4', serverUserId: 'su-4', name: 'Dee' }],
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

  it('links to Destinations when no email destination exists', () => {
    vi.mocked(useDestinations).mockReturnValue({ data: [discord] } as unknown as ReturnType<
      typeof useDestinations
    >);
    render(
      <MemoryRouter>
        <DeliveryFields {...props()} />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: 'newsletters.goToDestinations' })).toHaveAttribute(
      'href',
      '/settings/notifications/destinations'
    );
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
  it('evaluates the four checks', () => {
    const checks = readinessChecks({
      externalUrl: 'https://tracearr.example.com',
      destination: email,
      recipients: { resolvable: 2, known: true },
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
    });
    expect(bad.map((c) => c.status)).toEqual(['fail', 'fail', 'unknown', 'info']);
    const noUser = readinessChecks({
      externalUrl: null,
      destination: {
        ...email,
        config: { fromAddress: 'news@example.com', username: 'apikey' },
      } as unknown as Destination,
      recipients: { resolvable: 0, known: true },
    });
    expect(noUser[1]?.status).toBe('pass');
    expect(noUser[2]?.status).toBe('fail');
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
