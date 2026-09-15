import type { ComponentProps } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type {
  NewsletterExcludedPerson,
  NewsletterRecipientPerson,
  NewsletterRecipients,
  NewsletterRecipientsView,
  NewsletterResolvedRecipient,
} from '@tracearr/shared';
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
}));
// Radix's Avatar image only mounts once the browser reports the image loaded, which jsdom never does.
vi.mock('@/components/ui/avatar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/components/ui/avatar')>();
  return {
    ...actual,
    AvatarImage: (props: ComponentProps<'img'>) => <img alt="" {...props} />,
  };
});
import { useNewsletterRecipients } from '@/hooks/queries';
import { RecipientsPanel } from './RecipientsPanel';

const member = (
  userId: string,
  name: string,
  over: Partial<NewsletterResolvedRecipient> = {}
): NewsletterResolvedRecipient => ({
  address: `${name.toLowerCase()}@x.com`,
  userId,
  serverUserId: `su-${userId}`,
  name,
  suppressed: false,
  username: name.toLowerCase(),
  serverId: 's1',
  serverName: 'Home Plex',
  serverIds: ['s1'],
  thumbUrl: null,
  newSinceLastSend: false,
  addressFromUsername: false,
  ...over,
});

const excluded = (
  userId: string,
  name: string,
  reason: NewsletterExcludedPerson['reason']
): NewsletterExcludedPerson => ({
  userId,
  serverUserId: `su-${userId}`,
  name,
  username: name.toLowerCase(),
  serverId: 's1',
  serverName: 'Home Plex',
  serverIds: ['s1'],
  thumbUrl: null,
  reason,
});

const extra: NewsletterResolvedRecipient = {
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
  newSinceLastSend: false,
  addressFromUsername: false,
};

const cid: NewsletterRecipientPerson = {
  userId: 'u3',
  serverUserId: 'su-u3',
  name: 'Cid',
  username: 'cid',
  serverId: 's1',
  serverName: 'Home Plex',
  serverIds: ['s1'],
  thumbUrl: null,
};

function mockView(data: NewsletterRecipientsView | undefined, over: Record<string, unknown> = {}) {
  vi.mocked(useNewsletterRecipients).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
    error: null,
    refetch,
    ...over,
  } as unknown as ReturnType<typeof useNewsletterRecipients>);
}

function renderPanel({
  recipients = {},
  saved = [],
  newsletterId = 'n-1',
}: {
  recipients?: Partial<NewsletterRecipients>;
  saved?: string[];
  newsletterId?: string | null;
} = {}) {
  const onExclude = vi.fn();
  const onInclude = vi.fn();
  const { unmount } = render(
    <MemoryRouter>
      <RecipientsPanel
        form={{
          scope: { serverIds: [], libraries: [] },
          recipients: { members: true, extraAddresses: [], excludeUserIds: [], ...recipients },
        }}
        newsletterId={newsletterId}
        savedExcludeUserIds={saved}
        servers={[{ id: 's1', name: 'Home Plex' }]}
        onExclude={onExclude}
        onInclude={onInclude}
      />
    </MemoryRouter>
  );
  return { onExclude, onInclude, unmount };
}

const rowNames = () => screen.getAllByRole('listitem').map((row) => row.getAttribute('aria-label'));

describe('RecipientsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('asks about the unsaved form and lists who it reaches without a save first', () => {
    mockView({ recipients: [member('u1', 'Ann')], missing: [], excluded: [] });
    renderPanel({ newsletterId: null });
    const draft = vi.mocked(useNewsletterRecipients).mock.calls[0]?.[0];
    expect(draft).not.toHaveProperty('newsletterId');
    expect(draft?.recipients.members).toBe(true);
    expect(screen.getByRole('listitem', { name: 'Ann' })).toBeInTheDocument();
    expect(
      screen.getByText('newsletters.editor.recipients.willReceive:{"count":1}')
    ).toBeInTheDocument();
  });

  it('counts each group on one line and leaves out the empty ones', () => {
    mockView({
      recipients: [member('u1', 'Ann'), member('u2', 'Bob', { suppressed: true }), extra],
      missing: [cid],
      excluded: [excluded('u4', 'Dee', 'excluded'), excluded('u5', 'Eve', 'banned')],
    });
    renderPanel({ recipients: { excludeUserIds: ['u4'] }, saved: ['u4'] });
    expect(
      screen.getByText(
        [
          'newsletters.editor.recipients.willReceive:{"count":2}',
          'newsletters.editor.recipients.excludedCount:{"count":1}',
          'newsletters.editor.recipients.notIncludable:{"count":1}',
          'newsletters.editor.recipients.noAddress:{"count":1}',
          'newsletters.editor.recipients.suppressedCount:{"count":1}',
        ].join(' · ')
      )
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.manage:{"count":6}' })
    ).toBeInTheDocument();
    expect(screen.queryByText(/joinedSinceLastSend/)).not.toBeInTheDocument();
  });

  it('puts new members, people with no address and unsaved changes first, each badged', () => {
    mockView({
      recipients: [
        member('u1', 'Ann'),
        member('u2', 'Bea', { newSinceLastSend: true }),
        member('u6', 'Fay'),
      ],
      missing: [cid],
      excluded: [excluded('u4', 'Dee', 'excluded')],
    });
    renderPanel({ recipients: { excludeUserIds: ['u4'] }, saved: ['u6'] });
    expect(rowNames()).toEqual(['Bea', 'Cid', 'Fay', 'Dee']);
    expect(screen.getByRole('listitem', { name: 'Bea' })).toHaveTextContent(
      'newsletters.editor.recipients.newSinceLastSend'
    );
    expect(screen.getByRole('listitem', { name: 'Fay' })).toHaveTextContent(
      'newsletters.editor.recipients.includedAfterSave'
    );
    expect(screen.getByRole('listitem', { name: 'Dee' })).toHaveTextContent(
      'newsletters.editor.recipients.excludedAfterSave'
    );
    expect(
      screen.getByText('newsletters.editor.recipients.joinedSinceLastSend:{"count":1}')
    ).toBeInTheDocument();
  });

  it('shows the first eight receivers when nobody needs attention', () => {
    const people = Array.from({ length: 10 }, (_, i) => member(`u${i}`, `Person${i}`));
    mockView({ recipients: people, missing: [], excluded: [] });
    renderPanel();
    expect(rowNames()).toEqual(people.slice(0, 8).map((p) => p.name));
  });

  it('excludes a listed member and includes an excluded one back', async () => {
    mockView({
      recipients: [member('u2', 'Bea', { newSinceLastSend: true })],
      missing: [],
      excluded: [excluded('u4', 'Dee', 'excluded')],
    });
    const { onExclude, onInclude } = renderPanel({ recipients: { excludeUserIds: ['u4'] } });
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.exclude:{"name":"Bea"}' })
    );
    expect(onExclude).toHaveBeenCalledWith(['u2']);
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.include:{"name":"Dee"}' })
    );
    expect(onInclude).toHaveBeenCalledWith(['u4']);
  });

  it('saves a contact email through the account id, and refetches', async () => {
    identityMutate.mockImplementation((_vars: unknown, opts: { onSuccess: () => void }) =>
      opts.onSuccess()
    );
    mockView({ recipients: [], missing: [cid], excluded: [] });
    renderPanel();
    const input = screen.getByLabelText(
      'newsletters.editor.recipients.contactEmailFor:{"name":"Cid"}'
    );
    expect(input).toHaveValue('');
    await userEvent.type(input, 'cid@x.com');
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.saveEmail:{"name":"Cid"}' })
    );
    expect(identityMutate).toHaveBeenCalledWith(
      { id: 'su-u3', data: { contactEmail: 'cid@x.com' } },
      expect.anything()
    );
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state without asking when nobody could receive, and when the view lists nobody', () => {
    mockView(undefined);
    const { unmount } = renderPanel({
      recipients: { members: false, extraAddresses: [{ address: 'nope' }] },
    });
    expect(useNewsletterRecipients).toHaveBeenCalledWith(null);
    expect(screen.getByText('newsletters.editor.recipients.emptyTitle')).toBeInTheDocument();
    unmount();

    mockView({ recipients: [], missing: [], excluded: [] });
    renderPanel();
    expect(screen.getByText('newsletters.editor.recipients.emptyDescription')).toBeInTheDocument();
  });

  it('says why the recipients could not be loaded', () => {
    mockView(undefined, { isError: true, error: new Error('boom') });
    renderPanel();
    expect(screen.getByRole('alert')).toHaveTextContent('boom');
  });

  it('renders a member with the account avatar, a name link and the email, and an extra address with neither', () => {
    mockView({
      recipients: [member('u1', 'Sarah', { thumbUrl: '/library/avatar.png' }), extra],
      missing: [],
      excluded: [],
    });
    renderPanel();
    const row = screen.getByRole('listitem', { name: 'Sarah' });
    expect(row.querySelector('img')).toHaveAttribute(
      'src',
      getAvatarUrl('s1', '/library/avatar.png', 40) ?? ''
    );
    expect(screen.getByRole('link', { name: /Sarah/ })).toHaveAttribute('href', '/users/su-u1');
    expect(
      screen.getByText(
        'sarah@x.com · newsletters.editor.recipients.account:{"username":"sarah","server":"Home Plex"}'
      )
    ).toBeInTheDocument();
    const guest = screen.getByRole('listitem', { name: 'extra@x.com' });
    expect(guest).toHaveTextContent('newsletters.editor.recipients.extraAddress');
    expect(within(guest).queryByRole('link')).not.toBeInTheDocument();
    expect(within(guest).queryByRole('img')).not.toBeInTheDocument();
  });

  it('says when the address is the account username', () => {
    mockView({
      recipients: [
        member('u1', 'Fay', {
          username: 'fay@x.com',
          serverName: 'Emby',
          addressFromUsername: true,
        }),
      ],
      missing: [],
      excluded: [],
    });
    renderPanel();
    expect(
      screen.getByText(
        'fay@x.com · newsletters.editor.recipients.fromUsername · newsletters.editor.recipients.account:{"username":"fay@x.com","server":"Emby"}'
      )
    ).toBeInTheDocument();
  });

  it('opens the whole list in the manage sheet', async () => {
    mockView({ recipients: [member('u1', 'Ann')], missing: [], excluded: [] });
    renderPanel();
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.manage:{"count":1}' })
    );
    expect(
      within(screen.getByRole('dialog')).getByRole('listitem', { name: 'Ann' })
    ).toBeInTheDocument();
  });
});
