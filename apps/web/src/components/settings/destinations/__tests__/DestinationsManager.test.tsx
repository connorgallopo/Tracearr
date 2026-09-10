import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Destination } from '@tracearr/shared';
import { DestinationsManager } from '../DestinationsManager';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries/useDestinations', () => ({
  useDestinations: vi.fn(),
  useCreateDestination: vi.fn(),
  useUpdateDestination: vi.fn(),
  useDeleteDestination: vi.fn(),
  useTestDestination: vi.fn(),
  useTestUnsavedDestination: vi.fn(),
}));

import {
  useCreateDestination,
  useDeleteDestination,
  useDestinations,
  useTestDestination,
  useTestUnsavedDestination,
  useUpdateDestination,
} from '@/hooks/queries/useDestinations';

function mutationResult<T>(mutate: ReturnType<typeof vi.fn>): T {
  return { mutate, mutateAsync: vi.fn(), isPending: false } as unknown as T;
}

const updateMutate = vi.fn();
const deleteMutate = vi.fn();
const testMutate = vi.fn();

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'dest-discord',
    name: 'Discord',
    type: 'discord',
    enabled: true,
    builtin: false,
    events: ['violation_detected'],
    configStatus: 'ok',
    config: { webhookUrl: null },
    secretsSet: ['webhookUrl'],
    referencedByAutomationCount: 0,
    referencedByNewsletterCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const pushRow = destination({
  id: 'dest-push',
  name: 'Mobile push',
  type: 'push',
  builtin: true,
  config: null,
  secretsSet: [],
});

function rowMenus() {
  return screen.getAllByRole('button', { name: 'pages:settings.destinations.rowActions' });
}

function setDestinations(rows: Destination[]) {
  vi.mocked(useDestinations).mockReturnValue({
    data: rows,
    isLoading: false,
  } as unknown as ReturnType<typeof useDestinations>);
}

beforeEach(() => {
  updateMutate.mockReset();
  deleteMutate.mockReset();
  testMutate.mockReset();

  vi.mocked(useUpdateDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useUpdateDestination>>(updateMutate)
  );
  vi.mocked(useDeleteDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useDeleteDestination>>(deleteMutate)
  );
  vi.mocked(useTestDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useTestDestination>>(testMutate)
  );
  vi.mocked(useCreateDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useCreateDestination>>(vi.fn())
  );
  vi.mocked(useTestUnsavedDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useTestUnsavedDestination>>(vi.fn())
  );
});

describe('DestinationsManager', () => {
  it('offers the add button and nothing else when there are no destinations', () => {
    setDestinations([]);
    render(<DestinationsManager />);

    expect(screen.getByText('settings.destinations.empty')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'settings.destinations.add' })).toBeInTheDocument();
  });

  it('lists built-ins first and locks them: no delete, no test', async () => {
    const user = userEvent.setup();
    setDestinations([destination(), pushRow]);
    render(<DestinationsManager />);

    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Mobile push');
    expect(rows[1]).toHaveTextContent('Discord');
    expect(screen.getByText('pages:settings.destinations.builtinNote')).toBeInTheDocument();
    expect(screen.getByText('pages:settings.destinations.pushNote')).toBeInTheDocument();

    await user.click(rowMenus()[0]!);
    expect(
      screen.queryByRole('menuitem', { name: 'pages:settings.destinations.test' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('menuitem', { name: 'common:actions.delete' })
    ).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await user.click(rowMenus()[1]!);
    expect(
      screen.getByRole('menuitem', { name: 'pages:settings.destinations.test' })
    ).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'common:actions.delete' })).toBeInTheDocument();
  });

  it('flips enabled through the update mutation', async () => {
    const user = userEvent.setup();
    setDestinations([destination()]);
    render(<DestinationsManager />);

    await user.click(screen.getByRole('switch'));

    expect(updateMutate).toHaveBeenCalledWith({ id: 'dest-discord', data: { enabled: false } });
  });

  it('confirms before deleting', async () => {
    const user = userEvent.setup();
    setDestinations([destination()]);
    render(<DestinationsManager />);

    await user.click(rowMenus()[0]!);
    await user.click(screen.getByRole('menuitem', { name: 'common:actions.delete' }));
    expect(deleteMutate).not.toHaveBeenCalled();
    expect(screen.getByText('pages:settings.destinations.deleteConfirm')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'common:actions.delete' }));
    expect(deleteMutate).toHaveBeenCalledWith('dest-discord');
  });

  it('explains the disabled test action on a row whose config stopped decrypting', async () => {
    const user = userEvent.setup();
    setDestinations([destination({ configStatus: 'reencrypt' })]);
    render(<DestinationsManager />);

    await user.click(rowMenus()[0]!);

    expect(
      screen.getByRole('menuitem', { name: 'pages:settings.destinations.reencrypt' })
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('sends a test for a saved destination', async () => {
    const user = userEvent.setup();
    setDestinations([destination()]);
    render(<DestinationsManager />);

    await user.click(rowMenus()[0]!);
    await user.click(screen.getByRole('menuitem', { name: 'pages:settings.destinations.test' }));

    expect(testMutate).toHaveBeenCalledWith('dest-discord');
  });
});
