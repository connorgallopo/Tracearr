import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initI18n } from '@tracearr/translations';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { AutomationConditions, Condition, TriggerNode } from '@tracearr/shared';
import { ConditionsSection } from '../ConditionsSection';
import type { BuilderRefs } from '../builderRefs';
import type { NodeIssues } from '../validation';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const started: TriggerNode = {
  id: '11111111-1111-4111-8111-111111111111',
  type: 'session.started',
  enabled: true,
};
const down: TriggerNode = {
  id: '22222222-2222-4222-8222-222222222222',
  type: 'server.down',
  enabled: true,
};
const held: TriggerNode = {
  id: '33333333-3333-4333-8333-333333333333',
  type: 'session.held_for',
  enabled: true,
  params: { minutes: 30, measure: 'current' },
};

function condition(overrides: Partial<Condition> & { id: string }): Condition {
  return { enabled: true, field: 'concurrent_streams', operator: 'gte', value: 3, ...overrides };
}

function group(conditions: Condition[], match: 'all' | 'any' = 'all'): AutomationConditions {
  return { groups: [{ id: 'group-1', enabled: true, match, conditions }] };
}

function renderSection(
  conditions: AutomationConditions,
  triggers: TriggerNode[] = [started],
  issues: NodeIssues = new Map()
) {
  const dispatch = vi.fn();
  const refs: BuilderRefs = {
    triggers,
    kind: 'policy',
    conditions,
    filterOptions: undefined,
    describe: {},
    unitSystem: 'metric',
  };
  render(
    <TooltipProvider>
      <ConditionsSection
        conditions={conditions}
        refs={refs}
        issues={issues}
        pulseId={null}
        dispatch={dispatch}
      />
    </TooltipProvider>
  );
  return { dispatch };
}

/** The step is an <li> of its own, so its rows start after it. */
function rows() {
  return screen.getAllByRole('listitem').slice(1);
}

describe('ConditionsSection', () => {
  it('shows the step and what an empty one means, with one thing to do', async () => {
    const user = userEvent.setup();
    const { dispatch } = renderSection({ groups: [] });

    expect(screen.getByRole('heading', { name: /And only if/ })).toBeInTheDocument();
    expect(screen.getByText('No extra checks. This runs every time.')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Add a check/ }));

    expect(dispatch).toHaveBeenCalledWith({ type: 'addConditionGroup' });
  });

  it('joins the second check with a word the reader can change', async () => {
    const user = userEvent.setup();
    const { dispatch } = renderSection(
      group([
        condition({ id: 'c-1' }),
        condition({ id: 'c-2', field: 'is_local_network', operator: 'eq', value: true }),
      ])
    );

    const connective = screen.getByRole('combobox', { name: 'Join these checks with' });
    expect(connective).toHaveTextContent('and');

    await user.click(connective);
    await user.click(await screen.findByRole('option', { name: /any one check is enough/ }));

    expect(dispatch).toHaveBeenCalledWith({
      type: 'setConditionMatch',
      groupId: 'group-1',
      match: 'any',
    });
  });

  it('says nothing about joining while there is only one check', () => {
    renderSection(group([condition({ id: 'c-1' })]));

    expect(
      screen.queryByRole('combobox', { name: 'Join these checks with' })
    ).not.toBeInTheDocument();
  });

  it('keeps the reason it cannot offer a check in the tooltip, not in the line', () => {
    renderSection({ groups: [] }, [
      {
        id: '44444444-4444-4444-8444-444444444444',
        type: 'tracearr.update_available',
        enabled: true,
      },
    ]);

    expect(screen.getByText('No extra checks. This runs every time.')).toBeInTheDocument();
    expect(screen.queryByText(/don't offer any checks/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add a check/ })).toBeDisabled();
  });

  it('offers only the comparisons the picked field has', async () => {
    const user = userEvent.setup();
    renderSection(
      group([condition({ id: 'c-1', field: 'is_local_network', operator: 'eq', value: true })])
    );

    await user.click(screen.getByRole('combobox', { name: 'Is it' }));

    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByRole('option', { name: 'equals' })).toBeInTheDocument();
  });

  it('shows and updates the same-country mobile exception for travel speed', async () => {
    const user = userEvent.setup();
    const { dispatch } = renderSection(
      group([
        condition({
          id: 'c-1',
          field: 'travel_speed_kmh',
          operator: 'gt',
          value: 500,
          params: { exclude_same_device: true, skip_mobile_same_country: true },
        }),
      ])
    );

    const exception = screen.getByRole('checkbox', {
      name: 'Skip mobile devices when the country is unchanged',
    });
    expect(exception).toBeChecked();

    await user.click(exception);

    expect(dispatch).toHaveBeenCalledWith({
      type: 'setCondition',
      id: 'c-1',
      condition: {
        id: 'c-1',
        enabled: true,
        field: 'travel_speed_kmh',
        operator: 'gt',
        value: 500,
        params: { exclude_same_device: true, skip_mobile_same_country: false },
      },
    });
  });

  it('leaves one value behind when a list field moves from is one of to equals', async () => {
    const user = userEvent.setup();
    const { dispatch } = renderSection(
      group([condition({ id: 'c-1', field: 'country', operator: 'in', value: ['US', 'CA'] })])
    );

    await user.click(screen.getByRole('combobox', { name: 'Is it' }));
    await user.click(await screen.findByRole('option', { name: 'equals' }));

    expect(dispatch).toHaveBeenCalledWith({
      type: 'setCondition',
      id: 'c-1',
      condition: { id: 'c-1', enabled: true, field: 'country', operator: 'eq', value: 'US' },
    });
  });

  it('turns a row amber and names the trigger that cannot supply it', () => {
    renderSection(
      group([condition({ id: 'c-1', field: 'trust_score', operator: 'lt', value: 50 })]),
      [down],
      new Map([
        [
          'c-1',
          [
            {
              nodeId: 'c-1',
              message: 'Not available for: A server goes down',
              tone: 'warning' as const,
            },
          ],
        ],
      ])
    );

    expect(rows()[0]).toHaveAttribute('data-orphaned', 'true');
    // The amber carries on the row; the note itself stays at reading contrast.
    expect(screen.getByText('Not available for: A server goes down')).toHaveClass(
      'text-foreground'
    );
  });

  it('lifts a line’s controls onto their own row when the column is narrow', () => {
    renderSection(group([condition({ id: 'c-1' })]));

    const actions = rows()[0]?.querySelector('[data-slot="item-actions"]');
    expect(actions?.className).toContain('@max-lg:order-2');
    expect(actions?.className).toContain('@max-lg:ml-auto');
    expect(
      rows()[0]?.querySelector('[data-slot="item-actions"]')?.previousElementSibling?.className
    ).toContain('@max-lg:order-3');
  });

  it('says so when a threshold sits past the trigger that would fire it', () => {
    renderSection(
      group([condition({ id: 'c-1', field: 'current_pause_minutes', operator: 'gte', value: 60 })]),
      [held]
    );

    expect(
      screen.getByText('This can never pass. The trigger already fires at 30 minutes.')
    ).toBeInTheDocument();
  });

  it('toggles the focused row with D', async () => {
    const user = userEvent.setup();
    const { dispatch } = renderSection(group([condition({ id: 'c-1' })]));

    rows()[0]?.focus();
    await user.keyboard('d');

    expect(dispatch).toHaveBeenCalledWith({ type: 'toggleNode', id: 'c-1' });
  });
});
