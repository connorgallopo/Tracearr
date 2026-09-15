import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DismissedMergeSuggestion, MergeSuggestion } from '@tracearr/shared';
import { MergeSuggestionsCallout } from './MergeSuggestionsCallout';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const { mockDismiss, mockRestore } = vi.hoisted(() => ({
  mockDismiss: vi.fn(),
  mockRestore: vi.fn(),
}));

vi.mock('@/hooks/queries', () => ({
  useMergeSuggestions: vi.fn(),
  useDismissedMergeSuggestions: vi.fn(),
  useDismissMergeSuggestion: () => ({ mutate: mockDismiss, isPending: false }),
  useRestoreMergeSuggestion: () => ({ mutate: mockRestore, isPending: false }),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map(),
}));

import { useDismissedMergeSuggestions, useMergeSuggestions } from '@/hooks/queries';

const mockUseMergeSuggestions = vi.mocked(useMergeSuggestions);
const mockUseDismissed = vi.mocked(useDismissedMergeSuggestions);

function identity(
  userId: string,
  username: string,
  removedAt: string | null
): MergeSuggestion['users'][number] {
  return {
    userId,
    username,
    name: null,
    email: null,
    role: 'member',
    loginCapable: false,
    lastActivityAt: null,
    sessionCount: 0,
    serverUsers: [
      {
        id: `su-${userId}`,
        serverId: `server-${userId}`,
        serverName: 'Plex',
        username,
        email: 'bob@example.com',
        removedAt,
      },
    ],
  };
}

function suggestion(
  users: MergeSuggestion['users'] = [
    identity('user-a', 'bob', null),
    identity('user-b', 'bobby', '2026-01-01T00:00:00.000Z'),
  ]
): MergeSuggestion {
  return {
    matchType: 'email',
    matchValue: 'bob@example.com',
    users,
    requiredTargetUserId: null,
    suggestedTargetUserId: 'user-a',
    wouldCombineSameServer: false,
  };
}

function mockSuggestions(
  data: MergeSuggestion[] | undefined,
  dismissed: DismissedMergeSuggestion[] = []
) {
  mockUseMergeSuggestions.mockReturnValue({
    data,
    isLoading: data === undefined,
    isError: false,
  } as unknown as ReturnType<typeof useMergeSuggestions>);
  mockUseDismissed.mockReturnValue({
    data: dismissed,
  } as unknown as ReturnType<typeof useDismissedMergeSuggestions>);
}

async function openSheet() {
  await userEvent.click(screen.getByRole('button', { name: 'pages:users.suggestionsReview' }));
  return screen.getByRole('dialog');
}

describe('MergeSuggestionsCallout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders nothing without suggestions, even when dismissed pairs exist', () => {
    mockSuggestions([], [{ users: suggestion().users, dismissedAt: '2026-01-01T00:00:00.000Z' }]);
    const { container } = render(<MergeSuggestionsCallout onReview={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing while loading', () => {
    mockSuggestions(undefined);
    const { container } = render(<MergeSuggestionsCallout onReview={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an error message when loading fails', () => {
    mockUseMergeSuggestions.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useMergeSuggestions>);
    render(<MergeSuggestionsCallout onReview={vi.fn()} />);
    expect(screen.getByText('pages:users.suggestionsError')).toBeInTheDocument();
  });

  it('summarizes the first pair and forwards the one reviewed from the sheet', async () => {
    const items = [
      suggestion(),
      suggestion([identity('user-c', 'cy', null), identity('user-d', 'cyd', null)]),
    ];
    mockSuggestions(items);
    const onReview = vi.fn();
    render(<MergeSuggestionsCallout onReview={onReview} />);

    expect(screen.getByText('pages:users.suggestionsCount')).toBeInTheDocument();
    expect(screen.getByText('pages:users.suggestionsPairEmailMore')).toBeInTheDocument();

    const sheet = await openSheet();
    const rows = within(sheet).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    await userEvent.click(
      within(rows[1]!).getByRole('button', { name: 'pages:users.suggestionsReview' })
    );
    expect(onReview).toHaveBeenCalledWith(items[1]);
  });

  it('says the address may be a username when an account on either side uses it as one', async () => {
    mockSuggestions([
      suggestion([identity('user-a', 'bob', null), identity('user-b', 'Bob@Example.com', null)]),
    ]);
    render(<MergeSuggestionsCallout onReview={vi.fn()} />);

    expect(screen.getByText('pages:users.suggestionsPairEmailUsername')).toBeInTheDocument();
    const sheet = await openSheet();
    expect(
      within(sheet).getByText('pages:users.suggestionsMatchEmailUsername')
    ).toBeInTheDocument();
    expect(within(sheet).queryByText(/suggestionsMatchEmail:/)).not.toBeInTheDocument();
  });

  it('dismisses a pair the owner marks as not the same person', async () => {
    mockSuggestions([suggestion()]);
    render(<MergeSuggestionsCallout onReview={vi.fn()} />);

    const sheet = await openSheet();
    await userEvent.click(
      within(sheet).getByRole('button', { name: 'pages:users.suggestionsNotSame' })
    );
    expect(mockDismiss).toHaveBeenCalledWith(['user-a', 'user-b']);
  });

  it('restores a dismissed pair from the collapsed list', async () => {
    mockSuggestions(
      [suggestion()],
      [
        {
          users: [identity('user-e', 'eve', null), identity('user-f', 'evie', null)],
          dismissedAt: '2026-01-01T00:00:00.000Z',
        },
      ]
    );
    render(<MergeSuggestionsCallout onReview={vi.fn()} />);

    const sheet = await openSheet();
    await userEvent.click(
      within(sheet).getByRole('button', { name: 'pages:users.suggestionsDismissed' })
    );
    await userEvent.click(
      within(sheet).getByRole('button', { name: 'pages:users.suggestionsRestore' })
    );
    expect(mockRestore).toHaveBeenCalledWith(['user-e', 'user-f']);
  });

  it('marks only the identity whose every account is removed', async () => {
    mockSuggestions([suggestion()]);
    render(<MergeSuggestionsCallout onReview={vi.fn()} />);

    const sheet = await openSheet();
    expect(within(sheet).getAllByText('pages:users.mergeServerAccountRemoved')).toHaveLength(1);
  });
});
