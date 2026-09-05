import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { NewsletterRecipientsView } from '@tracearr/shared';
import { RecipientsPanel, partitionRecipients } from './RecipientsPanel';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));
const identityMutate = vi.fn();
const refetch = vi.fn();
vi.mock('@/hooks/queries', () => ({
  useNewsletterRecipients: vi.fn(),
  useUpdateUserIdentity: () => ({ mutate: identityMutate, isPending: false }),
}));
import { useNewsletterRecipients } from '@/hooks/queries';

const view: NewsletterRecipientsView = {
  recipients: [
    { address: 'ann@x.com', userId: 'u1', serverUserId: 'su-1', name: 'Ann', suppressed: false },
    { address: 'gone@x.com', userId: 'u2', serverUserId: 'su-2', name: 'Bob', suppressed: true },
    { address: 'extra@x.com', userId: null, serverUserId: null, name: null, suppressed: false },
  ],
  missing: [{ userId: 'u3', serverUserId: 'su-3', name: 'Cid' }],
  excluded: [{ userId: 'u4', serverUserId: 'su-4', name: 'Dee' }],
};

function renderPanel(excludeUserIds: string[] = ['u4'], id: string | null = 'n-1') {
  const onExclude = vi.fn();
  const onInclude = vi.fn();
  vi.mocked(useNewsletterRecipients).mockReturnValue({
    data: view,
    isLoading: false,
    isError: false,
    refetch,
  } as unknown as ReturnType<typeof useNewsletterRecipients>);
  render(
    <MemoryRouter>
      <RecipientsPanel
        newsletterId={id}
        excludeUserIds={excludeUserIds}
        onExclude={onExclude}
        onInclude={onInclude}
      />
    </MemoryRouter>
  );
  return { onExclude, onInclude };
}

describe('partitionRecipients', () => {
  it('moves a locally excluded person to the excluded list and a locally included one back', () => {
    const out = partitionRecipients(view, ['u4', 'u1']);
    expect(out.receive.map((r) => r.address)).toEqual(['gone@x.com', 'extra@x.com']);
    expect(out.excluded.map((p) => [p.userId, p.pending])).toEqual([
      ['u4', false],
      ['u1', true],
    ]);
    const back = partitionRecipients(view, []);
    expect(back.excluded).toEqual([]);
    expect(back.included.map((p) => p.userId)).toEqual(['u4']);
  });
});

describe('RecipientsPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('says to save first in create mode', () => {
    renderPanel([], null);
    expect(screen.getByText('newsletters.editor.recipients.saveFirst')).toBeInTheDocument();
    expect(useNewsletterRecipients).toHaveBeenCalledWith(undefined);
  });

  it('lists who will receive with counts, a suppressed badge, and an exclude action for members', async () => {
    const { onExclude } = renderPanel();
    expect(
      screen.getByText('newsletters.editor.recipients.willReceive:{"count":3}')
    ).toBeInTheDocument();
    expect(
      screen.getByText('newsletters.editor.recipients.noAddress:{"count":1}')
    ).toBeInTheDocument();
    expect(
      screen.getByText('newsletters.editor.recipients.excludedCount:{"count":1}')
    ).toBeInTheDocument();
    const bob = screen.getByRole('listitem', { name: 'gone@x.com' });
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
      screen.getByRole('link', { name: 'newsletters.editor.recipients.openUser' })
    ).toHaveAttribute('href', '/users/su-3');
  });

  it('shows the excluded list collapsed with an include action', async () => {
    const { onInclude } = renderPanel();
    expect(screen.queryByText('Dee')).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', {
        name: 'newsletters.editor.recipients.excludedCount:{"count":1}',
      })
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'newsletters.editor.recipients.include:{"name":"Dee"}' })
    );
    expect(onInclude).toHaveBeenCalledWith('u4');
  });

  it('offers an Exclude action on a person moved back from Excluded, same as any recipient', async () => {
    const { onExclude } = renderPanel([]);
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
      <MemoryRouter>
        <RecipientsPanel
          newsletterId="n-1"
          excludeUserIds={[]}
          onExclude={vi.fn()}
          onInclude={vi.fn()}
        />
      </MemoryRouter>
    );
    expect(screen.getByText('newsletters.editor.recipients.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('newsletters.editor.recipients.emptyDescription')).toBeInTheDocument();
    expect(
      screen.queryByText('newsletters.editor.recipients.willReceive:{"count":0}')
    ).not.toBeInTheDocument();
  });
});
