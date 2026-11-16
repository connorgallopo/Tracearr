/** Real i18n: the tab counts and the outcome words are what these cases are about. */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { Automation, AutomationRunSummary, NearMissReason, RunCounts } from '@tracearr/shared';

const useAutomationRuns = vi.fn();
const useRunCounts = vi.fn();
const useAutomationEvaluations = vi.fn();
vi.mock('@/hooks/queries/useRuns', () => ({
  useAutomationRuns: () => useAutomationRuns(),
  useRunCounts: () => useRunCounts(),
  useAutomationEvaluations: () => useAutomationEvaluations(),
}));

import { ActivityList } from './ActivityList';

function run(overrides: Partial<AutomationRunSummary> = {}): AutomationRunSummary {
  return {
    id: 'run-1',
    automationId: 'a-1',
    automationName: 'Impossible travel',
    kind: 'policy',
    outcome: 'completed',
    humanSummary: null,
    severity: 'warning',
    serverUserId: 'su-1',
    sessionId: 'sess-1',
    serverId: 'srv-1',
    subjectKey: 'sess-1',
    ranActions: [],
    subject: {
      kind: 'session',
      name: 'rebecc101',
      personName: 'Rebecca Lin',
      thumbUrl: null,
      serverName: 'Basement',
      libraryName: null,
      mediaType: null,
    },
    startedAt: '2026-08-19T12:00:00.000Z',
    finishedAt: '2026-08-19T12:00:01.000Z',
    acknowledgedAt: null,
    dismissedAt: null,
    ...overrides,
  };
}

const counts = (overrides: Partial<RunCounts> = {}): RunCounts => ({
  completed: 12,
  stopped_by_condition: 340,
  error: 0,
  total: 352,
  lastRunAt: '2026-08-19T12:00:00.000Z',
  ...overrides,
});

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const nearMiss = (reason: NearMissReason, at: string) => ({
  reason,
  at,
  subjectKey: `sess-${at}`,
  trigger: 'session.started',
});

beforeEach(() => {
  vi.clearAllMocks();
  useAutomationEvaluations.mockReturnValue({ data: { data: [] } });
});

function automation(overrides: Partial<Automation> = {}): Automation {
  return {
    id: 'a-1',
    name: 'Impossible travel',
    description: null,
    kind: 'policy',
    severity: 'warning',
    triggers: [{ id: 't-1', type: 'session.started', enabled: true }],
    conditions: { groups: [] },
    actions: { actions: [] },
    serverId: null,
    serverUserId: null,
    userId: null,
    enforceAcrossServers: false,
    isActive: true,
    cooldownMinutes: null,
    retentionDays: null,
    scopeRef: null,
    template: null,
    templateInputs: null,
    origin: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderList(
  rows: AutomationRunSummary[],
  tallies: RunCounts = counts(),
  row: Automation = automation()
) {
  useAutomationRuns.mockReturnValue({
    data: { data: rows, meta: { page: 1, pageSize: 20, total: rows.length } },
    isLoading: false,
  });
  useRunCounts.mockReturnValue({ data: tallies });
  render(
    <MemoryRouter>
      <ActivityList automation={row} onSelectRun={vi.fn()} />
    </MemoryRouter>
  );
}

const tab = (name: RegExp) => screen.getByRole('radio', { name });

describe('ActivityList', () => {
  it('says how many runs each tab holds', () => {
    renderList([run()]);

    expect(tab(/^Ran/)).toHaveTextContent('Ran12');
    expect(tab(/^No match/)).toHaveTextContent('No match340');
    expect(tab(/^Failed/)).toHaveTextContent('Failed0');
    expect(tab(/^All/)).toHaveTextContent('All352');
  });

  it('calls a run that matched nothing a non-match rather than a stop', () => {
    renderList([run({ outcome: 'stopped_by_condition' })]);

    expect(screen.getAllByText('No match')).toHaveLength(2);
  });

  it('shows a person with a face, and the way to their page', () => {
    renderList([run({ subject: { ...run().subject, thumbUrl: null } })]);

    const link = screen.getByRole('link', { name: /Rebecca Lin/ });
    expect(link).toHaveAttribute('href', '/users/su-1');
    expect(screen.queryByText(/rebecc101/)).not.toBeInTheDocument();
  });

  it('names the item rather than a person when the triggers watch media', () => {
    renderList(
      [
        run({
          serverUserId: null,
          subject: {
            kind: 'media',
            name: 'Dune',
            personName: null,
            thumbUrl: null,
            serverName: 'Basement',
            libraryName: 'Movies',
            mediaType: 'movie',
          },
        }),
      ],
      counts(),
      automation({ triggers: [{ id: 't-1', type: 'media.added', enabled: true }] })
    );

    expect(screen.getByRole('columnheader', { name: 'Item' })).toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Who' })).not.toBeInTheDocument();
    expect(screen.getByText('Dune')).toBeInTheDocument();
  });

  it('leaves the column out where no person and no item is possible', () => {
    renderList(
      [run()],
      counts(),
      automation({ triggers: [{ id: 't-1', type: 'server.up', enabled: true }] })
    );

    expect(screen.queryByRole('columnheader', { name: 'Who' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Item' })).not.toBeInTheDocument();
  });

  it('says what a run that ran actually did', () => {
    renderList([run({ ranActions: ['kill_stream'] })]);

    expect(screen.getByText('Recorded a violation · Stopped the stream')).toBeInTheDocument();
  });

  it('falls back to no notes while the steps are still being written', () => {
    renderList([run({ kind: 'notification', ranActions: [] })]);

    expect(screen.getByText('No notes')).toBeInTheDocument();
  });

  it('reads a run in five columns, with what it did second', () => {
    renderList([run()]);

    expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
      'Outcome',
      'Summary',
      'Who',
      'Where',
      'Severity',
      'Started',
    ]);
  });

  it('folds the matches that started nothing under the table', async () => {
    useAutomationEvaluations.mockReturnValue({
      data: {
        data: [
          nearMiss('cooldown_active', '2026-08-19T12:00:00.000Z'),
          nearMiss('gate_blocked', '2026-08-19T11:00:00.000Z'),
        ],
      },
    });
    renderList([run()]);

    expect(screen.queryByText('Cooldown was active')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /did not start a run \(2\)/ }));

    expect(screen.getByText('Cooldown was active')).toBeInTheDocument();
    expect(screen.getByText('An open run already covers this')).toBeInTheDocument();
  });

  it('says nothing about near misses when there were none', () => {
    renderList([run()]);

    expect(screen.queryByText(/did not start a run/)).not.toBeInTheDocument();
  });

  it('says nothing has run when nothing has', () => {
    renderList([], counts({ completed: 0, stopped_by_condition: 0, total: 0, lastRunAt: null }));

    expect(screen.getByText('No runs yet')).toBeInTheDocument();
    expect(screen.getByText('Runs are listed here once a trigger matches.')).toBeInTheDocument();
  });

  it('says nothing has run when every run failed, rather than counting no matches', () => {
    renderList([], counts({ completed: 0, stopped_by_condition: 0, error: 3, total: 3 }));

    expect(screen.getByText('No runs yet')).toBeInTheDocument();
  });

  it('counts the checks that ran when the Ran tab is the empty one', () => {
    renderList([], counts({ completed: 0, total: 340, lastRunAt: null }));

    expect(screen.getByText('Nothing has matched yet')).toBeInTheDocument();
    expect(screen.getByText('340 checks ran and did not match.')).toBeInTheDocument();
  });
});
