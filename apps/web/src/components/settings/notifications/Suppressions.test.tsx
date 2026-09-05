import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { EmailSuppression } from '@tracearr/shared';
import { Suppressions } from './Suppressions';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));
const addMutate = vi.fn();
const removeMutate = vi.fn();
vi.mock('@/hooks/queries', () => ({
  useEmailSuppressions: vi.fn(),
  useAddSuppression: () => ({ mutate: addMutate, isPending: false }),
  useRemoveSuppression: () => ({ mutate: removeMutate, isPending: false }),
}));
import { useEmailSuppressions } from '@/hooks/queries';

const rows: EmailSuppression[] = [
  {
    address: 'left@x.com',
    reason: 'unsubscribed',
    sourceSendId: 's-1',
    sourceNewsletterId: 'n-1',
    createdAt: '2026-09-01T10:00:00.000Z',
  },
  {
    address: 'manual@x.com',
    reason: 'manual',
    sourceSendId: null,
    sourceNewsletterId: null,
    createdAt: '2026-09-02T10:00:00.000Z',
  },
];

function renderCard(data = rows) {
  vi.mocked(useEmailSuppressions).mockReturnValue({
    data,
    isLoading: false,
    isError: false,
  } as unknown as ReturnType<typeof useEmailSuppressions>);
  return render(
    <MemoryRouter>
      <Suppressions />
    </MemoryRouter>
  );
}

describe('Suppressions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lists addresses with reason, date and a link to the source newsletter', () => {
    renderCard();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('left@x.com');
    expect(items[0]).toHaveTextContent('email.suppressions.reason.unsubscribed');
    expect(screen.getByRole('link', { name: 'email.suppressions.openSource' })).toHaveAttribute(
      'href',
      '/settings/notifications/newsletters/n-1?tab=history'
    );
    expect(items[1]).toHaveTextContent('email.suppressions.reason.manual');
    expect(screen.getByText('email.suppressions.globalNote')).toBeInTheDocument();
  });

  it('removes after confirming', async () => {
    renderCard();
    await userEvent.click(
      screen.getByRole('button', { name: 'email.suppressions.remove:{"address":"manual@x.com"}' })
    );
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'email.suppressions.removeDescription:{"address":"manual@x.com"}'
    );
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.remove' }));
    expect(removeMutate).toHaveBeenCalledWith('manual@x.com');
  });

  it('adds a validated address from the dialog, and the card keeps its title when empty', async () => {
    renderCard([]);
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('email.suppressions.title');
    expect(screen.getByText('email.suppressions.empty')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'email.suppressions.add' }));
    const input = screen.getByLabelText('email.suppressions.address');
    await userEvent.type(input, 'nope');
    expect(screen.getByRole('button', { name: 'email.suppressions.addConfirm' })).toBeDisabled();
    await userEvent.clear(input);
    await userEvent.type(input, 'Gone@X.com');
    await userEvent.click(screen.getByRole('button', { name: 'email.suppressions.addConfirm' }));
    expect(addMutate).toHaveBeenCalledWith('gone@x.com', expect.anything());
  });
});
