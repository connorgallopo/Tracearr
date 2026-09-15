import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type {
  NewsletterExcludedPerson,
  NewsletterRecipientsView,
  NewsletterResolvedRecipient,
} from '@tracearr/shared';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));
vi.mock('@/hooks/queries', () => ({
  useUpdateUserIdentity: () => ({ mutate: vi.fn(), isPending: false }),
}));
import { RecipientsSheet } from './RecipientsSheet';
import { partitionRecipients, pendingChange } from './recipientsView';

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

function renderSheet(view: NewsletterRecipientsView) {
  const actions = { onExclude: vi.fn(), onInclude: vi.fn(), onContactSaved: vi.fn() };
  render(
    <MemoryRouter>
      <RecipientsSheet
        open
        onOpenChange={vi.fn()}
        partition={partitionRecipients(view)}
        servers={[{ id: 's1', name: 'Home Plex' }]}
        pending={(userId) => pendingChange(userId, [], [])}
        actions={actions}
      />
    </MemoryRouter>
  );
  return actions;
}

const names = () =>
  within(screen.getByRole('dialog'))
    .getAllByRole('listitem')
    .map((row) => row.getAttribute('aria-label'));

const searchBox = () => screen.getByRole('textbox', { name: 'common:actions.search' });

describe('RecipientsSheet', () => {
  it('searches names, usernames and addresses, and only shows tabs with someone in them', async () => {
    renderSheet({
      recipients: [
        member('u1', 'Ann'),
        member('u2', 'Bob', { username: 'bobby' }),
        member('u3', 'Cat', { address: 'cat@home.org' }),
      ],
      missing: [],
      excluded: [],
    });
    expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual([
      'newsletters.editor.recipients.tabs.receiving:{"count":3}',
    ]);
    await userEvent.type(searchBox(), 'home');
    await waitFor(() => expect(names()).toEqual(['Cat']));
    await userEvent.clear(searchBox());
    await userEvent.type(searchBox(), 'BOBBY');
    await waitFor(() => expect(names()).toEqual(['Bob']));
  });

  it('selects everyone the search leaves and excludes them together', async () => {
    const extra = {
      ...member('x', 'x'),
      userId: null,
      serverUserId: null,
      name: null,
      username: null,
      address: 'guest@x.com',
      serverIds: [],
    };
    const { onExclude } = renderSheet({
      recipients: [member('u1', 'Ann'), member('u2', 'Anders'), member('u3', 'Bob'), extra],
      missing: [],
      excluded: [],
    });
    expect(
      screen.getByRole('checkbox', { name: 'newsletters.editor.recipients.selectAll:{"count":3}' })
    ).toBeInTheDocument();
    await userEvent.type(searchBox(), 'an');
    await waitFor(() => expect(names()).toEqual(['Ann', 'Anders']));
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'newsletters.editor.recipients.selectAll:{"count":2}' })
    );
    expect(
      screen.getByText('newsletters.editor.recipients.selectedCount:{"count":2}')
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.excludeSelected' })
    );
    expect(onExclude).toHaveBeenCalledWith(['u1', 'u2']);
  });

  it('gives every excluded person a reason, and counts and includes only the ones the owner excluded', async () => {
    const { onInclude } = renderSheet({
      recipients: [member('u1', 'Ann')],
      missing: [],
      excluded: [
        excluded('u4', 'Dee', 'excluded'),
        excluded('u5', 'Eve', 'banned'),
        excluded('u6', 'Fay', 'pending'),
        excluded('u7', 'Gus', 'noServer'),
      ],
    });
    await userEvent.click(
      screen.getByRole('tab', { name: 'newsletters.editor.recipients.tabs.excluded:{"count":1}' })
    );
    expect(
      screen.getByText('newsletters.editor.recipients.notIncludableHelp:{"count":3}')
    ).toBeInTheDocument();
    const reasons = { Dee: 'excluded', Eve: 'banned', Fay: 'pending', Gus: 'noServer' };
    for (const [name, reason] of Object.entries(reasons)) {
      const row = screen.getByRole('listitem', { name });
      expect(row).toHaveTextContent(`newsletters.editor.recipients.reasons.${reason}`);
      expect(within(row).queryByRole('button', { name: /\.include:/ }) !== null).toBe(
        name === 'Dee'
      );
    }
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'newsletters.editor.recipients.selectAll:{"count":1}' })
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.includeSelected' })
    );
    expect(onInclude).toHaveBeenCalledWith(['u4']);
  });
});
