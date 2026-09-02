import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  DESTINATION_KINDS,
  DESTINATION_TYPES,
  EMAIL_SMTP_PRESETS,
  type Destination,
  type DestinationKind,
} from '@tracearr/shared';
import { ApiError } from '@/lib/api';
import { DestinationDialog } from '../DestinationDialog';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/queries/useDestinations', () => ({
  useCreateDestination: vi.fn(),
  useUpdateDestination: vi.fn(),
  useTestDestination: vi.fn(),
  useTestUnsavedDestination: vi.fn(),
}));

import {
  useCreateDestination,
  useTestDestination,
  useTestUnsavedDestination,
  useUpdateDestination,
} from '@/hooks/queries/useDestinations';

function mutationResult<T>(mutateAsync: ReturnType<typeof vi.fn>): T {
  return { mutate: vi.fn(), mutateAsync, isPending: false } as unknown as T;
}

const createAsync = vi.fn();
const updateAsync = vi.fn();
const testUnsavedAsync = vi.fn();

const CONFIGURABLE = DESTINATION_KINDS.filter((kind) => !DESTINATION_TYPES[kind].builtin);

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'dest-1',
    name: 'Pushover',
    type: 'pushover',
    enabled: true,
    builtin: false,
    events: ['violation_detected'],
    configStatus: 'ok',
    config: { userKey: null, apiToken: null },
    secretsSet: ['userKey', 'apiToken'],
    referencedByAutomationCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  createAsync.mockReset().mockResolvedValue(undefined);
  updateAsync.mockReset().mockResolvedValue(undefined);
  testUnsavedAsync.mockReset().mockResolvedValue(undefined);

  vi.mocked(useCreateDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useCreateDestination>>(createAsync)
  );
  vi.mocked(useUpdateDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useUpdateDestination>>(updateAsync)
  );
  vi.mocked(useTestDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useTestDestination>>(vi.fn())
  );
  vi.mocked(useTestUnsavedDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useTestUnsavedDestination>>(testUnsavedAsync)
  );
});

function renderCreate() {
  render(<DestinationDialog open onOpenChange={vi.fn()} mode="create" />);
}

async function pickType(user: ReturnType<typeof userEvent.setup>, kind: DestinationKind) {
  await user.click(
    screen.getByRole('button', {
      name: `pages:settings.destinations.types.${DESTINATION_TYPES[kind].label}`,
    })
  );
}

describe('DestinationDialog create mode', () => {
  it('offers a card for every configurable type and none for the built-ins', () => {
    renderCreate();

    for (const kind of CONFIGURABLE) {
      expect(
        screen.getByRole('button', {
          name: `pages:settings.destinations.types.${DESTINATION_TYPES[kind].label}`,
        })
      ).toBeInTheDocument();
    }
    expect(
      screen.queryByRole('button', { name: 'pages:settings.destinations.types.push' })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'pages:settings.destinations.types.webToast' })
    ).not.toBeInTheDocument();
  });

  it.each(CONFIGURABLE)(
    'renders %s fields and events straight from the descriptor',
    async (kind) => {
      const user = userEvent.setup();
      renderCreate();
      await pickType(user, kind);

      const descriptor = DESTINATION_TYPES[kind];
      for (const field of descriptor.fields) {
        const input = screen.getByLabelText(new RegExp(`fields\\.${field.label}`));
        expect(input).toHaveAttribute('id', `destination-${field.key}`);
        if (field.input === 'secret') {
          expect(input).toHaveAttribute('type', 'password');
        } else {
          expect(input).not.toHaveAttribute('type', 'password');
        }
      }

      expect(screen.getByLabelText('pages:settings.destinations.receiveViolations')).toBeChecked();
      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    }
  );

  it('saves the violation subscription the switch is left on', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pickType(user, 'discord');
    await user.type(
      screen.getByLabelText(/fields\.webhookUrl/),
      'https://discord.com/api/webhooks/1/x'
    );
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    expect(createAsync).toHaveBeenCalledWith(
      expect.objectContaining({ events: ['violation_detected'] })
    );
  });

  it('saves no subscription once the switch is off', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pickType(user, 'discord');
    await user.type(
      screen.getByLabelText(/fields\.webhookUrl/),
      'https://discord.com/api/webhooks/1/x'
    );
    await user.click(screen.getByLabelText('pages:settings.destinations.receiveViolations'));
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    expect(createAsync).toHaveBeenCalledWith(expect.objectContaining({ events: [] }));
  });

  it('keeps Save disabled until every required field is filled', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pickType(user, 'discord');

    const save = screen.getByRole('button', { name: 'common:actions.save' });
    expect(save).toBeDisabled();

    await user.type(
      screen.getByLabelText(/fields\.webhookUrl/),
      'https://discord.com/api/webhooks/1/x'
    );
    expect(save).toBeEnabled();

    await user.click(save);
    expect(createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'discord',
        config: { webhookUrl: 'https://discord.com/api/webhooks/1/x' },
      })
    );
  });

  it('shows what the server said when the name is already taken', async () => {
    const user = userEvent.setup();
    createAsync.mockRejectedValue(
      new ApiError('A destination named "Discord" already exists', 409, {
        message: 'A destination named "Discord" already exists',
      })
    );
    renderCreate();
    await pickType(user, 'discord');
    await user.type(
      screen.getByLabelText(/fields\.webhookUrl/),
      'https://discord.com/api/webhooks/1/x'
    );
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    expect(
      await screen.findByText('A destination named "Discord" already exists')
    ).toBeInTheDocument();
  });

  it('tests the unsaved config without saving it', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pickType(user, 'discord');
    await user.type(screen.getByLabelText(/fields\.webhookUrl/), 'https://example.com/hook');
    await user.click(screen.getByRole('button', { name: /destinations\.test/ }));

    expect(testUnsavedAsync).toHaveBeenCalledWith({
      type: 'discord',
      config: { webhookUrl: 'https://example.com/hook' },
    });
    expect(createAsync).not.toHaveBeenCalled();
  });
});

describe('DestinationDialog edit mode', () => {
  it('shows stored secrets as set and leaves untouched ones out of the patch', async () => {
    const user = userEvent.setup();
    render(
      <DestinationDialog open onOpenChange={vi.fn()} mode="edit" destination={destination()} />
    );

    const userKey = screen.getByLabelText(/fields\.userKey/);
    const apiToken = screen.getByLabelText(/fields\.apiToken/);
    expect(userKey).toHaveAttribute('placeholder', 'pages:settings.destinations.secretSet');
    expect(userKey).toHaveValue('');
    expect(apiToken).toHaveAttribute('placeholder', 'pages:settings.destinations.secretSet');

    await user.type(userKey, 'u-new');
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    expect(updateAsync).toHaveBeenCalledWith({
      id: 'dest-1',
      data: {
        name: 'Pushover',
        enabled: true,
        events: ['violation_detected'],
        config: { userKey: 'u-new' },
      },
    });
  });

  it('treats every field of a reencrypt row as unfilled until retyped', async () => {
    const user = userEvent.setup();
    render(
      <DestinationDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        destination={destination({ configStatus: 'reencrypt', config: null, secretsSet: [] })}
      />
    );

    const save = screen.getByRole('button', { name: 'common:actions.save' });
    expect(save).toBeDisabled();
    const userKey = screen.getByLabelText(/fields\.userKey/);
    expect(userKey).not.toHaveAttribute('placeholder', 'pages:settings.destinations.secretSet');

    await user.type(userKey, 'u');
    await user.type(screen.getByLabelText(/fields\.apiToken/), 't');
    expect(save).toBeEnabled();
    await user.click(save);
    expect(updateAsync).toHaveBeenCalledWith({
      id: 'dest-1',
      data: expect.objectContaining({ config: { userKey: 'u', apiToken: 't' } }),
    });
  });

  it('sends null for a secret the user clears', async () => {
    const user = userEvent.setup();
    render(
      <DestinationDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        destination={destination({
          type: 'ntfy',
          config: { url: 'https://ntfy.sh/', topic: 'tracearr', authToken: null },
          secretsSet: ['url', 'authToken'],
        })}
      />
    );

    const clearButtons = screen.getAllByRole('button', {
      name: 'pages:settings.destinations.clearSecret',
    });
    const authTokenClear = clearButtons[clearButtons.length - 1];
    expect(authTokenClear).toBeDefined();
    if (!authTokenClear) throw new Error('no clear button rendered');

    await user.click(authTokenClear);
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    expect(updateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ config: { authToken: null } }) })
    );
  });

  it('narrows a row that still holds pre-automation subscriptions to violations only', async () => {
    const user = userEvent.setup();
    render(
      <DestinationDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        destination={destination({
          type: 'push',
          builtin: true,
          config: null,
          secretsSet: [],
          events: ['stream_started', 'violation_detected'],
        })}
      />
    );

    expect(screen.getByLabelText('pages:settings.destinations.receiveViolations')).toBeChecked();
    expect(screen.queryByRole('button', { name: /destinations\.test/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    expect(updateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ events: ['violation_detected'] }) })
    );
  });

  it('leaves the switch off for a row that never subscribed to violations', () => {
    render(
      <DestinationDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        destination={destination({ events: ['stream_started'] })}
      />
    );

    expect(
      screen.getByLabelText('pages:settings.destinations.receiveViolations')
    ).not.toBeChecked();
  });
});

describe('email kind', () => {
  async function openEmail() {
    const user = userEvent.setup();
    renderCreate();
    await user.click(
      screen.getByRole('button', { name: 'pages:settings.destinations.types.email' })
    );
    return user;
  }

  const label = (key: string) => new RegExp(`pages:settings\\.destinations\\.fields\\.${key}\\b`);

  it('renders a provider select, a numeric port and address inputs', async () => {
    await openEmail();
    expect(screen.getByLabelText(label('preset'))).toHaveAttribute('role', 'combobox');
    const port = screen.getByLabelText(label('port'));
    expect(port).toHaveAttribute('type', 'number');
    expect(port).toHaveAttribute('min', '1');
    expect(port).toHaveAttribute('max', '65535');
    expect(port).toHaveValue(587);
    expect(screen.getByLabelText(label('fromAddress'))).toHaveAttribute('type', 'email');
  });

  it('copies host, port and security from a preset and saves them as strings', async () => {
    const user = await openEmail();
    await user.click(screen.getByLabelText(label('preset')));
    await user.click(
      screen.getByRole('option', { name: 'pages:settings.destinations.options.presetResend' })
    );
    expect(screen.getByLabelText(label('host'))).toHaveValue(EMAIL_SMTP_PRESETS.resend.host);
    expect(screen.getByLabelText(label('port'))).toHaveValue(
      Number(EMAIL_SMTP_PRESETS.resend.port)
    );

    await user.type(screen.getByLabelText(label('fromAddress')), 'plex@example.com');
    await user.type(screen.getByLabelText(label('to')), 'a@example.com');
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));
    expect(createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'email',
        config: expect.objectContaining({
          preset: 'resend',
          host: EMAIL_SMTP_PRESETS.resend.host,
          port: EMAIL_SMTP_PRESETS.resend.port,
          security: EMAIL_SMTP_PRESETS.resend.security,
        }),
      })
    );
  });

  it('saves the defaults as strings when no preset is picked', async () => {
    const user = await openEmail();
    await user.type(screen.getByLabelText(label('host')), 'smtp.example.com');
    await user.type(screen.getByLabelText(label('fromAddress')), 'plex@example.com');
    await user.type(screen.getByLabelText(label('to')), 'a@example.com');
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));
    expect(createAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'email',
        config: expect.objectContaining({
          preset: 'custom',
          host: 'smtp.example.com',
          port: '587',
          security: 'starttls',
          fromName: 'Tracearr',
          fromAddress: 'plex@example.com',
          to: 'a@example.com',
          messagesPerSecond: '2',
        }),
      })
    );
  });
});
