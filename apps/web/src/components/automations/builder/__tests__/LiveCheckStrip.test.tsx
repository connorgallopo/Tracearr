import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { initI18n } from '@tracearr/translations';
import type { CreateAutomationInput, DryRunSample } from '@tracearr/shared';

const { dryRun } = vi.hoisted(() => ({ dryRun: vi.fn() }));
vi.mock('@/hooks/queries/useDryRun', () => ({ useDryRun: dryRun }));

import { LiveCheckStrip } from '../LiveCheckStrip';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

beforeEach(() => {
  dryRun.mockReset();
});

const sample: DryRunSample = {
  subject: {
    sessionId: 's1',
    user: { id: 'u1', name: 'Connor' },
    server: { id: 'srv1', name: 'Beehive' },
  },
  triggers: ['session.started'],
  conditions: [
    {
      nodeId: 'c-1',
      passed: false,
      evidence: {
        field: 'is_local_network',
        operator: 'eq',
        threshold: false,
        actual: true,
        matched: false,
      },
    },
    {
      nodeId: 'c-2',
      passed: true,
      evidence: {
        field: 'concurrent_streams',
        operator: 'gte',
        threshold: 2,
        actual: 3,
        matched: true,
      },
    },
  ],
  actions: [],
  wouldRun: false,
  summary: 'Would not run for Connor on Beehive: the user is on the local network.',
};

function definition(overrides: Partial<CreateAutomationInput> = {}): CreateAutomationInput {
  return {
    name: 'Nightly sweep',
    kind: 'policy',
    severity: 'warning',
    triggers: [
      { id: '11111111-1111-4111-8111-111111111111', type: 'session.started', enabled: true },
    ],
    conditions: { groups: [] },
    actions: { actions: [] },
    ...overrides,
  };
}

function renderStrip(input = definition(), route = '/automations/a-1/edit') {
  render(
    <MemoryRouter initialEntries={[route]}>
      <LiveCheckStrip definition={input} ready paused={false} />
    </MemoryRouter>
  );
}

describe('LiveCheckStrip', () => {
  it('says nothing when no session trigger can reach a session', () => {
    dryRun.mockReturnValue({ data: undefined, isPending: false, isError: false });
    renderStrip(
      definition({
        triggers: [
          { id: '22222222-2222-4222-8222-222222222222', type: 'server.down', enabled: true },
        ],
      })
    );

    expect(screen.queryByText('Right now on the servers')).not.toBeInTheDocument();
  });

  it('reads the verdict for each session back in words', () => {
    dryRun.mockReturnValue({ data: { samples: [sample] }, isPending: false, isError: false });
    renderStrip();

    expect(screen.getByText(sample.summary)).toBeInTheDocument();
    expect(
      screen.getByText("Cooldowns and sessions already handled aren't simulated.")
    ).toBeInTheDocument();
  });

  it('marks each condition once a session is opened', async () => {
    const user = userEvent.setup();
    dryRun.mockReturnValue({ data: { samples: [sample] }, isPending: false, isError: false });
    renderStrip();

    expect(screen.queryByText(/Local Network/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Connor/ }));

    const rows = screen.getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('Did not pass');
    expect(rows[1]).toHaveTextContent('Passed');
  });

  describe('replaying one run', () => {
    const replay = '/automations/a-1/edit?sample=sess-7';

    it('checks the run its session came from, not what is playing now', () => {
      dryRun.mockReturnValue({ data: { samples: [sample] }, isPending: false, isError: false });
      renderStrip(definition(), replay);

      expect(dryRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sampleSessionId: 'sess-7' })
      );
      expect(screen.getByText('What this would do to that run')).toBeInTheDocument();
      expect(screen.queryByText('Right now on the servers')).not.toBeInTheDocument();
    });

    it('says the session is gone rather than blaming the check', () => {
      dryRun.mockReturnValue({ data: undefined, isPending: false, isError: true });
      renderStrip(definition(), replay);

      expect(
        screen.getByText('That session is no longer on record; nothing to check against.')
      ).toBeInTheDocument();
    });

    it('says the same when the run matched nothing to check', () => {
      dryRun.mockReturnValue({ data: { samples: [] }, isPending: false, isError: false });
      renderStrip(definition(), replay);

      expect(
        screen.getByText('That session is no longer on record; nothing to check against.')
      ).toBeInTheDocument();
    });

    it('drops the sample and goes back to live sessions', async () => {
      const user = userEvent.setup();
      dryRun.mockReturnValue({ data: { samples: [sample] }, isPending: false, isError: false });
      renderStrip(definition(), replay);

      await user.click(screen.getByRole('button', { name: "Back to what's playing now" }));

      expect(screen.getByText('Right now on the servers')).toBeInTheDocument();
      expect(dryRun).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({ sampleSessionId: undefined })
      );
    });

    it('reads what is playing now when no run was named', () => {
      dryRun.mockReturnValue({ data: { samples: [sample] }, isPending: false, isError: false });
      renderStrip();

      expect(dryRun).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sampleSessionId: undefined })
      );
      expect(screen.getByText('Right now on the servers')).toBeInTheDocument();
    });
  });
});
