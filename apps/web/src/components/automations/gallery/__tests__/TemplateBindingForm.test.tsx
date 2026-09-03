import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initI18n } from '@tracearr/translations';
import type { Destination } from '@tracearr/shared';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import type { AutomationTemplate } from '@/lib/api';
import {
  BLOCKED_COUNTRIES,
  CONCURRENT_STREAMS,
  KILL_PAUSED,
  NO_INPUTS,
  STREAM_STARTED,
} from './fixtures';

vi.mock('@/hooks/queries/useSettings', () => ({
  useSettings: () => ({ data: { unitSystem: 'metric' } }),
}));
vi.mock('@/hooks/useServer', () => ({
  useServer: () => ({ servers: [{ id: 'server-1', name: 'Beehive' }] }),
}));
vi.mock('@/hooks/queries/useUsers', () => ({ useUsers: () => ({ data: undefined }) }));
vi.mock('@/hooks/queries/useHistory', () => ({
  useAutomationFilterOptions: () => ({ data: undefined }),
}));

const destination: Destination = {
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
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('@/hooks/queries/useDestinations', () => ({
  useDestinations: () => ({ data: [destination] }),
}));

vi.mock('@/components/settings/destinations/DestinationDialog', () => ({
  DestinationDialog: ({
    open,
    onOpenChange,
  }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Destination dialog</DialogTitle>
      </DialogContent>
    </Dialog>
  ),
}));

import { TemplateBindingForm } from '../TemplateBindingForm';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const onPrimary = vi.fn();
const onSecondary = vi.fn();

beforeEach(() => {
  onPrimary.mockReset();
  onSecondary.mockReset();
});

function renderForm(template: AutomationTemplate = STREAM_STARTED, showInstanceFields = true) {
  render(
    <TemplateBindingForm
      template={template}
      showInstanceFields={showInstanceFields}
      doors={{
        primaryLabel: 'Use this',
        onPrimary,
        pending: false,
        secondaryLabel: 'Open in the builder',
        onSecondary,
        helper: 'Either way works.',
      }}
    />
  );
  return { user: userEvent.setup() };
}

const sentence = () => screen.getByText('In plain words').parentElement?.textContent ?? '';

/** The clause the focused field wrote, as the panel renders it. */
const lit = () =>
  screen.getByText('In plain words').parentElement?.querySelector('.bg-primary\\/15')
    ?.textContent ?? '';

describe('TemplateBindingForm', () => {
  it('opens on Any server, with the template name and Active on', () => {
    renderForm();

    expect(screen.getByLabelText('Name')).toHaveValue('Stream started');
    expect(screen.getByRole('combobox', { name: /Which server/ })).toHaveTextContent('Any server');
    expect(screen.getByRole('switch')).toBeChecked();
  });

  it('tells the story in order and puts the name last', () => {
    renderForm();

    // The two blocks are landmarks now; the sentence panel is the only heading left.
    const headings = [...document.querySelectorAll('h2, h3')].map((node) => node.textContent);
    expect(headings).toEqual(['In plain words']);
    expect(screen.getByRole('region', { name: 'What it needs' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'What this will do' })).toBeInTheDocument();

    const labels = [...document.querySelectorAll('label')].map((node) => node.textContent);
    expect(labels).toEqual(['Which server', 'Send to', 'Name', 'Turn it on now']);
  });

  it('says what it will do to a person', () => {
    renderForm(KILL_PAUSED);

    expect(screen.getByText('Can stop a stream that is playing.')).toBeInTheDocument();
    expect(screen.getByText('Runs on every server.')).toBeInTheDocument();
  });

  it('reassures on a template that only sends messages', () => {
    renderForm();

    expect(
      screen.getByText('Only notifies. Never stops a stream or changes an account.')
    ).toBeInTheDocument();
  });

  it('names the destination in the sentence once one is picked', async () => {
    const { user } = renderForm();

    expect(sentence()).toContain('send a notification');

    await user.click(screen.getByRole('button', { name: 'Discord' }));

    expect(sentence()).toContain('send to Discord');
  });

  it('lets the reader add a destination without leaving the form', async () => {
    const { user } = renderForm();

    await user.click(screen.getByRole('button', { name: 'New destination' }));

    expect(await screen.findByText('Destination dialog')).toBeInTheDocument();
  });

  it('moves the sentence tail, the scope line and the name together on a server pick', async () => {
    const { user } = renderForm();

    await user.click(screen.getByRole('combobox', { name: /Which server/ }));
    await user.click(await screen.findByRole('option', { name: 'Beehive' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Stream started — Beehive');
    expect(sentence()).toContain('Applies to Beehive.');
    expect(screen.getByText('Runs on Beehive only.')).toBeInTheDocument();

    await user.type(screen.getByLabelText('Name'), '!');
    await user.click(screen.getByRole('combobox', { name: /Which server/ }));
    await user.click(await screen.findByRole('option', { name: 'Any server' }));

    expect(screen.getByLabelText('Name')).toHaveValue('Stream started — Beehive!');
  });

  it('lights the clause a focused field wrote, and clears it on the way out', async () => {
    const { user } = renderForm(CONCURRENT_STREAMS);

    expect(lit()).toBe('');

    await user.click(screen.getByLabelText('Streams allowed'));
    expect(lit()).toContain('the stream count is above 3');

    await user.tab();
    expect(lit()).toBe('');
  });

  it('keeps the clause lit while the picker it belongs to is open', async () => {
    const { user } = renderForm();

    await user.click(screen.getByRole('combobox', { name: /Which server/ }));
    await user.click(await screen.findByRole('option', { name: 'Beehive' }));

    expect(lit()).toContain('Applies to Beehive');

    // The list is portalled out of the field, so focus leaving is not the reader leaving.
    await user.click(screen.getByRole('combobox', { name: /Which server/ }));
    expect(await screen.findByRole('option', { name: 'Beehive' })).toBeInTheDocument();

    expect(lit()).toContain('Applies to Beehive');
  });

  it('says when a viewer message is shown, since the sentence never mentions it', () => {
    renderForm(KILL_PAUSED);

    expect(screen.getByText('Shown on the player when the stream stops.')).toBeInTheDocument();
  });

  it('holds a missing destination back until the reader submits', async () => {
    const { user } = renderForm();

    expect(screen.queryByText('Pick at least one.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Use this' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Use this' }));

    expect(screen.getByText('Pick at least one.')).toBeInTheDocument();
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('hands the primary door the bound inputs and the name it shows', async () => {
    const { user } = renderForm();

    await user.click(screen.getByRole('button', { name: 'Discord' }));
    await user.click(screen.getByRole('button', { name: 'Use this' }));

    expect(onPrimary).toHaveBeenCalledWith({
      inputs: { to: ['dest-discord'] },
      name: 'Stream started',
      isActive: true,
    });
  });

  it('sends a policy template with its numbers already filled in', async () => {
    const { user } = renderForm(CONCURRENT_STREAMS);

    expect(sentence()).toContain('the stream count is above 3');

    await user.click(screen.getByRole('button', { name: 'Use this' }));

    expect(onPrimary).toHaveBeenCalledWith(
      expect.objectContaining({ inputs: { max: 3 }, isActive: true })
    );
  });

  it('drops a clause from the sentence when the switch that gates it goes off', async () => {
    const { user } = renderForm(BLOCKED_COUNTRIES);

    expect(sentence()).toContain('the user is not on the local network');

    await user.click(screen.getByRole('switch', { name: 'Ignore local network sessions' }));

    expect(sentence()).not.toContain('the user is not on the local network');
  });

  it('falls back to the template name when the name is emptied', async () => {
    const { user } = renderForm(CONCURRENT_STREAMS);

    await user.clear(screen.getByLabelText('Name'));
    await user.tab();

    expect(screen.getByLabelText('Name')).toHaveValue('Too many streams at once');

    await user.click(screen.getByRole('button', { name: 'Use this' }));

    expect(onPrimary).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Too many streams at once' })
    );
  });

  it('lands the automation paused when Active is turned off', async () => {
    const { user } = renderForm(CONCURRENT_STREAMS);

    await user.click(screen.getByRole('switch'));
    await user.click(screen.getByRole('button', { name: 'Use this' }));

    expect(onPrimary).toHaveBeenCalledWith(expect.objectContaining({ isActive: false }));
  });

  it('hands the second door the answers the reader typed, not the defaults', async () => {
    const { user } = renderForm();

    await user.click(screen.getByRole('button', { name: 'Discord' }));
    await user.click(screen.getByRole('combobox', { name: /Which server/ }));
    await user.click(await screen.findByRole('option', { name: 'Beehive' }));
    await user.click(screen.getByRole('button', { name: 'Open in the builder' }));

    expect(onSecondary).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Stream started — Beehive', serverId: 'server-1' })
    );
    const [draft] = onSecondary.mock.calls[0] as [{ actions: { actions: unknown[] } }];
    expect(draft.actions.actions[0]).toMatchObject({ type: 'send', to: ['dest-discord'] });
  });

  it('leaves out the name and the switch when the row already exists', () => {
    renderForm(CONCURRENT_STREAMS, false);

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  });

  it('keeps every blank label above its control, which is the dialog shape', () => {
    renderForm();

    const rows = [...document.querySelectorAll('[data-slot=field][data-orientation]')];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.getAttribute('data-orientation') === 'vertical')).toBe(true);
  });

  it('carries no limits of its own: a row being created has none to set', () => {
    renderForm();

    expect(screen.queryByRole('group', { name: 'This automation' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Keep runs for')).not.toBeInTheDocument();
  });

  it('says there is nothing to fill in when a template has no inputs', () => {
    renderForm(NO_INPUTS);

    expect(screen.getByText('Nothing to fill in.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'What it needs' })).not.toBeInTheDocument();
  });
});
