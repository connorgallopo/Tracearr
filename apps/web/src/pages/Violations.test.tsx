import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import type * as ReactRouter from 'react-router';
import type { ViolationWithDetails } from '@tracearr/shared';
import { Violations } from './Violations';

const navigate = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof ReactRouter>('react-router');
  return { ...actual, useNavigate: () => navigate };
});

vi.mock('@/hooks/queries', () => ({
  useViolations: vi.fn(),
  useUsers: vi.fn(),
  useAutomations: vi.fn(),
  useAcknowledgeViolation: () => ({ mutate: vi.fn(), isPending: false }),
  useDismissViolation: () => ({ mutate: vi.fn(), isPending: false }),
  useBulkAcknowledgeViolations: vi.fn(),
  useBulkDismissViolations: vi.fn(),
}));

vi.mock('@/hooks/useServer', () => ({
  useServer: vi.fn(),
}));

vi.mock('@/hooks/useServerColorMap', () => ({
  useServerColorMap: () => new Map<string, string>(),
}));

import {
  useViolations,
  useUsers,
  useAutomations,
  useBulkAcknowledgeViolations,
  useBulkDismissViolations,
} from '@/hooks/queries';
import { useServer } from '@/hooks/useServer';

const mockUseViolations = vi.mocked(useViolations);
const mockUseUsers = vi.mocked(useUsers);
const mockUseAutomations = vi.mocked(useAutomations);
const mockUseBulkAcknowledge = vi.mocked(useBulkAcknowledgeViolations);
const mockUseBulkDismiss = vi.mocked(useBulkDismissViolations);
const mockUseServer = vi.mocked(useServer);

function violation(id: string, ruleName: string): ViolationWithDetails {
  return {
    id,
    ruleId: `rule-${id}`,
    serverUserId: `su-${id}`,
    sessionId: null,
    severity: 'high',
    data: {},
    createdAt: new Date('2026-08-01T00:00:00Z'),
    acknowledgedAt: null,
    rule: { id: `rule-${id}`, name: ruleName, type: 'concurrent_streams' },
    user: {
      id: `su-${id}`,
      username: `user-${id}`,
      thumbUrl: null,
      serverId: 'server-1',
      identityName: null,
      userId: `person-${id}`,
    },
  };
}

const rows = [violation('v1', 'Rule One'), violation('v2', 'Rule Two'), violation('v3', 'Rule 3')];

/** Every filter set at once, so a param dropped on the way out is visible. */
const FULLY_FILTERED_URL =
  '/violations?severity=high&status=pending&rule=rule-7&occurredFrom=2026-01-01&occurredTo=2026-02-01&people=person-v1';

const FULL_FILTER_PARAMS = {
  serverIds: undefined,
  severity: 'high',
  acknowledged: false,
  userIds: ['person-v1'],
  ruleId: 'rule-7',
  startDate: '2026-01-01',
  endDate: '2026-02-01',
};

function mockList(loaded: ViolationWithDetails[], total: number) {
  mockUseViolations.mockReturnValue({
    data: { data: loaded, meta: { page: 1, pageSize: 10, total } },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useViolations>);
}

/** The arguments of the most recent list query, which is what the table drives. */
function lastQueryArgs() {
  const calls = mockUseViolations.mock.calls;
  return calls[calls.length - 1]?.[0];
}

function bodyRows() {
  const rowGroups = screen.getAllByRole('rowgroup');
  return within(rowGroups[rowGroups.length - 1]!).getAllByRole('row');
}

/** The bulk toolbar's copy of an action; each row carries one of its own. */
function toolbarButton(name: RegExp) {
  return screen.getAllByRole('button', { name }).find((button) => button.closest('table') === null);
}

function renderViolations(path = '/violations') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Violations />
    </MemoryRouter>
  );
}

describe('Violations', () => {
  const bulkAcknowledgeMutate = vi.fn();
  const bulkDismissMutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseServer.mockReturnValue({
      selectedServerIds: [],
      selectedServers: [],
      isMultiServer: false,
    } as unknown as ReturnType<typeof useServer>);
    mockUseUsers.mockReturnValue({
      data: { data: [], meta: { page: 1, pageSize: 100, total: 0 } },
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useUsers>);
    mockUseAutomations.mockReturnValue({
      data: {
        data: [{ id: 'rule-7', name: 'Rule Seven' }],
        meta: { page: 1, pageSize: 100, total: 1 },
      },
    } as unknown as ReturnType<typeof useAutomations>);
    mockUseBulkAcknowledge.mockReturnValue({
      mutate: bulkAcknowledgeMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useBulkAcknowledgeViolations>);
    mockUseBulkDismiss.mockReturnValue({
      mutate: bulkDismissMutate,
      isPending: false,
    } as unknown as ReturnType<typeof useBulkDismissViolations>);
    mockList(rows, 25);
  });

  it('renders every loaded row and the translated pager status', () => {
    renderViolations();

    expect(bodyRows()).toHaveLength(3);
    expect(screen.getByText('Rule One')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'common:table.pagination' })).toBeInTheDocument();
    expect(screen.getByText('common:table.pageOf')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /common:actions.previous/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /common:actions.next/ })).toBeEnabled();
  });

  it('offers only policy automations in the rule filter', () => {
    renderViolations();

    expect(mockUseAutomations).toHaveBeenCalledWith(expect.objectContaining({ kind: 'policy' }));
  });

  it('sends the mapped sort field to the query and returns to page one', async () => {
    const user = userEvent.setup();
    renderViolations();

    await user.click(screen.getByRole('button', { name: /common:labels.severity/ }));

    expect(lastQueryArgs()).toMatchObject({ page: 1, orderBy: 'severity', orderDir: 'asc' });
  });

  it('leaves the status header unsortable so it cannot clear the server order', () => {
    renderViolations();

    expect(screen.queryByRole('button', { name: /common:labels.status/ })).not.toBeInTheDocument();
  });

  it('reads the severity, status and rule filters out of the URL and sends them as query params', () => {
    renderViolations(FULLY_FILTERED_URL);

    expect(lastQueryArgs()).toMatchObject({
      severity: 'high',
      acknowledged: false,
      ruleId: 'rule-7',
      userIds: ['person-v1'],
    });
  });

  it('sends a linked date filter as calendar-date bounds', () => {
    renderViolations('/violations?occurredFrom=2026-01-01&occurredTo=2026-02-01');

    expect(lastQueryArgs()).toMatchObject({
      startDate: '2026-01-01',
      endDate: '2026-02-01',
    });
  });

  it('sends an open-ended date bound on its own', () => {
    renderViolations('/violations?occurredTo=2026-02-01');

    expect(lastQueryArgs()).toMatchObject({ startDate: undefined, endDate: '2026-02-01' });
  });

  it('drops a filter chip out of the query and returns to page one', async () => {
    const user = userEvent.setup();
    renderViolations(FULLY_FILTERED_URL);

    await user.click(screen.getByRole('button', { name: /common:actions.next/ }));
    expect(lastQueryArgs()).toMatchObject({ page: 2 });

    // Chips follow descriptor order, so the first one is severity.
    await user.click(screen.getAllByRole('button', { name: 'common:filters.remove' })[0]!);

    expect(lastQueryArgs()).toMatchObject({ page: 1, severity: undefined, ruleId: 'rule-7' });
  });

  it('puts a person into the query from the row action', async () => {
    const user = userEvent.setup();
    renderViolations();

    await user.click(
      screen.getAllByRole('button', { name: 'pages:violations.filterByPerson' })[0]!
    );

    expect(lastQueryArgs()).toMatchObject({ page: 1, userIds: ['person-v1'] });
  });

  it('marks the clicked row selected and hands the bulk action its id', async () => {
    const user = userEvent.setup();
    renderViolations();

    const checkboxes = screen.getAllByRole('checkbox', { name: 'common:table.selectRow' });
    await user.click(checkboxes[1]!);

    expect(bodyRows()[1]).toHaveAttribute('data-state', 'selected');
    expect(bodyRows()[0]).not.toHaveAttribute('data-state', 'selected');

    await user.click(toolbarButton(/common:actions.acknowledge/)!);

    expect(bulkAcknowledgeMutate).toHaveBeenCalledWith(
      { ids: ['v2'] },
      expect.objectContaining({ onSuccess: expect.any(Function) })
    );
  });

  it('selects the whole page from the header checkbox', async () => {
    const user = userEvent.setup();
    renderViolations();

    await user.click(screen.getByRole('checkbox', { name: 'common:table.selectAllOnPage' }));

    for (const row of bodyRows()) {
      expect(row).toHaveAttribute('data-state', 'selected');
    }
  });

  it('sends every active filter with a select-all dismiss, not just the server scope', async () => {
    const user = userEvent.setup();
    renderViolations(FULLY_FILTERED_URL);

    await user.click(screen.getAllByRole('checkbox', { name: 'common:table.selectRow' })[0]!);
    await user.click(screen.getByRole('button', { name: 'pages:violations.selectAllViolations' }));
    await user.click(toolbarButton(/common:actions.dismiss/)!);

    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      within(dialog).getByRole('button', { name: 'pages:violations.dismissViolations' })
    );

    expect(bulkDismissMutate).toHaveBeenCalledWith(
      { selectAll: true, filters: FULL_FILTER_PARAMS },
      expect.anything()
    );
  });

  it('narrows the select-all acknowledge to the same filters as the list', async () => {
    const user = userEvent.setup();
    renderViolations(FULLY_FILTERED_URL);

    await user.click(screen.getAllByRole('checkbox', { name: 'common:table.selectRow' })[0]!);
    await user.click(screen.getByRole('button', { name: 'pages:violations.selectAllViolations' }));
    await user.click(toolbarButton(/common:actions.acknowledge/)!);

    expect(bulkAcknowledgeMutate).toHaveBeenCalledWith(
      { selectAll: true, filters: FULL_FILTER_PARAMS },
      expect.anything()
    );
  });

  it('navigates to the violation when its row is clicked', async () => {
    const user = userEvent.setup();
    renderViolations();

    await user.click(screen.getByText('Rule Two'));

    expect(navigate).toHaveBeenCalledWith('/violations/v2');
  });

  it('does not navigate when the row checkbox is ticked', async () => {
    const user = userEvent.setup();
    renderViolations();

    await user.click(screen.getAllByRole('checkbox', { name: 'common:table.selectRow' })[0]!);

    expect(navigate).not.toHaveBeenCalled();
  });

  it('tells an empty log apart from an empty filter result', () => {
    mockList([], 0);
    const { unmount } = renderViolations();

    expect(screen.getByText('pages:violations.noViolationsRecorded')).toBeInTheDocument();
    unmount();

    renderViolations(FULLY_FILTERED_URL);

    expect(screen.getByText('pages:violations.tryAdjustingFilters')).toBeInTheDocument();
  });

  it('shows an error state instead of the table, and retry refetches', async () => {
    const refetch = vi.fn();
    mockUseViolations.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error('violations failed'),
      refetch,
    } as unknown as ReturnType<typeof useViolations>);

    renderViolations();

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByText('violations failed')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(refetch).toHaveBeenCalled();
  });
});
