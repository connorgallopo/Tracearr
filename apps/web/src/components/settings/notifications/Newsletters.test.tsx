import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type { Destination, Newsletter } from '@tracearr/shared';
import { Newsletters } from './Newsletters';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));

const navigate = vi.fn();
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@/components/settings/destinations/DestinationDialog', () => ({
  DestinationDialog: ({
    open,
    initialKind,
    onCreated,
  }: {
    open: boolean;
    initialKind?: string;
    onCreated?: (created: { id: string }) => void;
  }) =>
    open ? (
      <div>
        <span>dialog kind: {initialKind}</span>
        <button type="button" onClick={() => onCreated?.({ id: 'dest-new' })}>
          simulate created
        </button>
      </div>
    ) : null,
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: vi.fn() }));

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
const duplicateMutate = vi.fn();
const previewMutate = vi.fn();
vi.mock('@/hooks/queries', () => ({
  useNewsletters: vi.fn(),
  useDestinations: vi.fn(),
  useUpdateNewsletter: () => ({ mutate: updateMutate, isPending: false, variables: undefined }),
  useDeleteNewsletter: () => ({ mutate: deleteMutate, isPending: false }),
  useDuplicateNewsletter: () => ({ mutate: duplicateMutate, isPending: false }),
  usePreviewNewsletter: () => ({ mutate: previewMutate, isPending: false }),
  useSendNewsletter: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { useAuth } from '@/hooks/useAuth';
import { useDestinations, useNewsletters } from '@/hooks/queries';

const emailDestination = { id: 'd-1', type: 'email', enabled: true } as Destination;
const newsletter = {
  id: 'n-1',
  name: 'Weekly',
  enabled: true,
  destinationId: 'd-1',
  schedule: { kind: 'daily', time: '09:00' },
  timezone: 'UTC',
  lastSend: null,
  nextRunAt: null,
} as Newsletter;

function renderPage({
  role = 'owner',
  newsletters = [] as Newsletter[],
  destinations = [emailDestination] as Destination[],
  isLoading = false,
  destinationsLoading = false,
} = {}) {
  vi.mocked(useAuth).mockReturnValue({ user: { role } } as unknown as ReturnType<typeof useAuth>);
  vi.mocked(useNewsletters).mockReturnValue({
    data: newsletters,
    isLoading,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useNewsletters>);
  vi.mocked(useDestinations).mockReturnValue({
    data: destinations,
    isLoading: destinationsLoading,
    isError: false,
    error: null,
  } as unknown as ReturnType<typeof useDestinations>);
  return render(
    <MemoryRouter>
      <Newsletters />
    </MemoryRouter>
  );
}

describe('Newsletters section', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('tells an admin the page is owner-only', () => {
    renderPage({ role: 'admin' });
    expect(screen.getByRole('alert')).toHaveTextContent('newsletters.ownerOnly');
    expect(useNewsletters).not.toHaveBeenCalled();
  });

  it('creates the email destination in place and lands on the new newsletter with it selected', async () => {
    renderPage({ destinations: [] });
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent(
      'newsletters.noDestinationTitle'
    );
    expect(screen.getByText('newsletters.noDestinationDescription')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'newsletters.new' })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'newsletters.addEmailDestination' }));
    expect(screen.getByText('dialog kind: email')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'simulate created' }));
    expect(navigate).toHaveBeenCalledWith('/settings/notifications/newsletters/new', {
      state: { destinationId: 'dest-new' },
    });
  });

  it('hides the destination guidance and shows a skeleton while destinations are still loading', () => {
    const { container } = renderPage({ newsletters: [newsletter], destinationsLoading: true });

    expect(screen.queryByText('newsletters.noDestinationTitle')).not.toBeInTheDocument();
    expect(container.querySelector('[data-slot="skeleton"]')).toBeInTheDocument();
  });

  it('shows the header action once destinations resolve to an email destination', () => {
    renderPage({ newsletters: [newsletter] });

    expect(screen.getByRole('button', { name: 'newsletters.new' })).toBeInTheDocument();
  });

  it('offers a new newsletter from the empty state and the header', async () => {
    renderPage();
    expect(screen.getByRole('heading', { level: 3 })).toHaveTextContent('newsletters.empty');
    const buttons = screen.getAllByRole('button', { name: 'newsletters.new' });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[0]!);
    expect(navigate).toHaveBeenCalledWith('/settings/notifications/newsletters/new');
  });

  it('lists rows, toggles enabled with a patch, and confirms before deleting', async () => {
    renderPage({ newsletters: [newsletter] });
    expect(screen.getByRole('list')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'newsletters.enabled' }));
    expect(updateMutate).toHaveBeenCalledWith({ id: 'n-1', data: { enabled: false } });

    await userEvent.click(screen.getByRole('button', { name: 'newsletters.rowActions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'common:actions.delete' }));
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'newsletters.deleteDescription:{"name":"Weekly"}'
    );
    await userEvent.click(screen.getByRole('button', { name: 'common:actions.delete' }));
    expect(deleteMutate).toHaveBeenCalledWith('n-1', expect.anything());
  });

  it('offers Send now from the row menu and previews before confirming', async () => {
    renderPage({ newsletters: [newsletter] });
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.rowActions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'newsletters.sendNow' }));
    expect(previewMutate).toHaveBeenCalledWith('n-1', expect.anything());
    expect(screen.getByRole('alertdialog')).toHaveTextContent(
      'newsletters.editor.send.title:{"name":"Weekly"}'
    );
  });

  it('duplicates through the hook and opens the copy', async () => {
    duplicateMutate.mockImplementation(
      (_id: string, opts: { onSuccess: (copy: Newsletter) => void }) =>
        opts.onSuccess({ ...newsletter, id: 'n-2' })
    );
    renderPage({ newsletters: [newsletter] });
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.rowActions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'newsletters.duplicate' }));
    expect(duplicateMutate).toHaveBeenCalledWith('n-1', expect.anything());
    expect(navigate).toHaveBeenCalledWith('/settings/notifications/newsletters/n-2');
  });
});
