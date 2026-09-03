import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { initI18n } from '@tracearr/translations';
import {
  AUTOMATION_DESCRIPTION_MAX,
  AUTOMATION_NAME_MAX,
  type Automation,
  type Destination,
  type TemplateDefinition,
  type TemplateInput,
} from '@tracearr/shared';
import { ApiError } from '@/lib/api';
import { templateDraft, type AutomationDraft } from '@/lib/automations';

vi.mock('@/hooks/useServer', () => ({ useServer: () => ({ servers: [] }) }));
vi.mock('@/hooks/queries/useSettings', () => ({
  useSettings: () => ({ data: { unitSystem: 'metric' } }),
}));
vi.mock('@/hooks/queries/useUsers', () => ({ useUsers: () => ({ data: undefined }) }));
vi.mock('@/hooks/queries/useHistory', () => ({
  useAutomationFilterOptions: () => ({ data: undefined }),
}));
const destination: Destination = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  name: 'Discord',
  type: 'discord',
  enabled: true,
  builtin: false,
  events: ['violation_detected'],
  configStatus: 'ok',
  config: { webhookUrl: null },
  secretsSet: ['webhookUrl'],
  referencedByAutomationCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('@/hooks/queries/useDestinations', () => ({
  useDestinations: () => ({ data: [destination] }),
}));
vi.mock('@/hooks/queries/useDryRun', () => ({
  useDryRun: () => ({ data: undefined, isPending: false, isError: false }),
}));

const create = vi.fn();
const update = vi.fn();

vi.mock('@/hooks/queries/useAutomations', () => ({
  useCreateAutomation: () => ({ mutateAsync: create, isPending: false }),
  useUpdateAutomation: () => ({ mutateAsync: update, isPending: false }),
}));

import { AutomationBuilder } from '../AutomationBuilder';
import { nodeDomId } from '../builderReducer';
import { BUILDER_SECTIONS } from '../validation';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

beforeEach(() => {
  create.mockReset();
  create.mockResolvedValue({ id: 'new-1' });
  update.mockReset();
  update.mockResolvedValue({ id: 'a1' });
});

function storedAutomation(overrides: Partial<Automation>): Automation {
  return {
    id: 'a1',
    name: 'Stored',
    description: null,
    kind: 'notification',
    severity: null,
    triggers: [],
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
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

function renderBuilder(automation?: Automation, draft?: AutomationDraft) {
  const router = createMemoryRouter(
    [
      {
        path: '/automations/*',
        element: <AutomationBuilder automation={automation} draft={draft} />,
      },
    ],
    { initialEntries: ['/automations/new'] }
  );
  return render(<RouterProvider router={router} />);
}

/** What "Open in the builder" hands over: a send whose destination may still be unpicked. */
function templateDraftFor(bound: Record<string, unknown>): AutomationDraft {
  const inputs: TemplateInput[] = [
    { key: 'to', kind: 'destinations', label: 'Send to', required: true },
  ];
  const definition: TemplateDefinition = {
    kind: 'notification',
    triggers: [
      { id: '99999999-9999-4999-8999-999999999999', type: 'session.started', enabled: true },
    ],
    conditions: { groups: [] },
    actions: {
      actions: [
        {
          id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          type: 'send',
          enabled: true,
          to: { $input: 'to' },
        },
      ],
    },
    scope: {},
    enforceAcrossServers: false,
    cooldownMinutes: null,
  };

  return templateDraft({ inputs, definition }, bound, { name: 'Stream started', isActive: true });
}

async function addTrigger(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('button', { name: /Choose what starts it/ }));
  await user.click(await screen.findByRole('option', { name }));
}

describe('AutomationBuilder', () => {
  it('opens on an empty When section and a sentence that says so', () => {
    renderBuilder();

    expect(screen.getByText('What should start this?')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /When something happens/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /do something/ })).toBeInTheDocument();
  });

  it('takes an empty slot in the sentence to the step that fills it', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.click(screen.getByRole('button', { name: /do something/ }));

    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.getElementById(nodeDomId(BUILDER_SECTIONS.actions))
      )
    );
  });

  it('counts what is left in a calm voice until Save asks for the form', async () => {
    const user = userEvent.setup();
    renderBuilder();

    expect(screen.getByText('2 left to finish')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /to fix/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    expect(screen.getByRole('button', { name: /2 things to fix/ })).toBeInTheDocument();
  });

  it('grows the sentence as triggers land', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await addTrigger(user, /Playback confirmed/);

    expect(await screen.findByRole('button', { name: /When a stream starts/ })).toBeInTheDocument();
  });

  it('counts what is left to fix and clears the count as the form fills', async () => {
    const user = userEvent.setup();
    renderBuilder();

    expect(screen.getByText('2 left to finish')).toBeInTheDocument();

    await addTrigger(user, /Playback confirmed/);
    await user.type(screen.getByLabelText('Name'), 'Nightly sweep');

    await waitFor(() => expect(screen.getByText('Ready to save')).toBeInTheDocument());
  });

  it('greets a new automation without red until Save asks for the whole form', async () => {
    const user = userEvent.setup();
    renderBuilder();

    expect(screen.queryByText('Give this automation a name')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).not.toHaveAttribute('aria-invalid', 'true');

    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    expect(screen.getByText('Give this automation a name')).toBeInTheDocument();
    expect(screen.getByText('Add what starts this, or switch one back on')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('takes the problem count to the scope when that is what is unfinished', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await addTrigger(user, /Playback confirmed/);
    await user.type(screen.getByLabelText('Name'), 'Nightly sweep');
    await user.click(screen.getByRole('radio', { name: 'One account' }));

    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    expect(document.activeElement).toBe(document.getElementById(nodeDomId(BUILDER_SECTIONS.scope)));
  });

  it('lets the user fix what the API rejected and try again', async () => {
    const user = userEvent.setup();
    create.mockRejectedValueOnce(
      new ApiError('Validation failed', 400, {
        details: { fields: [{ field: 'body.triggers.0.params.minutes', message: 'Too big' }] },
      })
    );
    renderBuilder();

    await addTrigger(user, /paused longer than the set number of minutes/);
    await user.type(screen.getByLabelText('Name'), 'Nightly sweep');
    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    expect(await screen.findByText('Between 1 and 1440 minutes')).toBeInTheDocument();

    const minutes = screen.getByLabelText('Minutes');
    await user.clear(minutes);
    await user.type(minutes, '45');

    expect(screen.queryByText('Between 1 and 1440 minutes')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(2));
  });

  it('opens the nearest picker on slash', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.keyboard('/');

    expect(
      await screen.findByPlaceholderText('Search or describe what should happen')
    ).toBeInTheDocument();
  });

  it('puts the name and the description on the one raised card, with the sentence', () => {
    renderBuilder();

    const card = screen.getByLabelText('Name').closest('.bg-card-raised');
    expect(card).not.toBeNull();
    expect(
      within(card as HTMLElement).getByPlaceholderText('What this is for')
    ).toBeInTheDocument();
    expect(within(card as HTMLElement).getByText('In plain words')).toBeInTheDocument();
  });

  it('takes a description beside the name in the summary card', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.type(screen.getByPlaceholderText('What this is for'), 'Nightly sweep');

    expect(screen.getByPlaceholderText('What this is for')).toHaveValue('Nightly sweep');
  });

  it('stops the name and the description at the length the schema allows', () => {
    renderBuilder();

    expect(screen.getByLabelText('Name')).toHaveAttribute('maxLength', String(AUTOMATION_NAME_MAX));
    expect(screen.getByPlaceholderText('What this is for')).toHaveAttribute(
      'maxLength',
      String(AUTOMATION_DESCRIPTION_MAX)
    );
  });

  it('takes the caret to an open picker rather than shutting it', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.keyboard('/');
    const search = await screen.findByPlaceholderText('Search or describe what should happen');

    await user.keyboard('/');

    expect(screen.getByPlaceholderText('Search or describe what should happen')).toBe(search);
    expect(document.activeElement).toBe(search);
  });

  it('opens the branch it is pointing at before it lands on the row', async () => {
    const user = userEvent.setup();
    renderBuilder(
      storedAutomation({
        name: 'Branching',
        triggers: [
          { id: '99999999-9999-4999-8999-999999999999', type: 'session.started', enabled: true },
        ],
        actions: {
          actions: [
            {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              type: 'if',
              conditions: { groups: [] },
              then: [],
              else: [{ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', type: 'send', to: [] }],
            },
          ],
        },
      })
    );

    await user.click(screen.getByRole('button', { name: /Hide this branch/ }));
    expect(screen.queryByText('Send Notification')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(screen.getByText('Send Notification')).toBeInTheDocument();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        document.getElementById(nodeDomId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'))
      )
    );
  });

  it('refuses to save a condition the triggers cannot supply, and says which', async () => {
    const user = userEvent.setup();
    renderBuilder(
      storedAutomation({
        name: 'Server watch',
        triggers: [
          { id: '99999999-9999-4999-8999-999999999999', type: 'server.down', enabled: true },
        ],
        conditions: {
          groups: [
            {
              id: '88888888-8888-4888-8888-888888888888',
              conditions: [
                {
                  id: '77777777-7777-4777-8777-777777777777',
                  field: 'trust_score',
                  operator: 'lt',
                  value: 50,
                },
              ],
            },
          ],
        },
      })
    );

    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    expect(await screen.findByText('Not available for: A server goes down')).toBeInTheDocument();
    expect(update).not.toHaveBeenCalled();
  });

  it('opens a template draft whose destination is still unpicked, and asks for one', async () => {
    const user = userEvent.setup();
    renderBuilder(undefined, templateDraftFor({}));

    expect(screen.getByRole('button', { name: /send a notification/ })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    expect(screen.getByText('Pick at least one destination')).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it('carries a destination the reader did pick into the sentence', () => {
    renderBuilder(undefined, templateDraftFor({ to: [destination.id] }));

    expect(screen.getByRole('button', { name: /send to Discord/ })).toBeInTheDocument();
  });

  it('saves the triggers it was given', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await addTrigger(user, /Playback confirmed/);
    await user.type(screen.getByLabelText('Name'), 'Nightly sweep');
    await user.click(screen.getByRole('button', { name: 'Create automation' }));

    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    expect(create.mock.calls[0]?.[0]).toMatchObject({
      name: 'Nightly sweep',
      kind: 'policy',
      triggers: [expect.objectContaining({ type: 'session.started', enabled: true })],
    });
  });
});
