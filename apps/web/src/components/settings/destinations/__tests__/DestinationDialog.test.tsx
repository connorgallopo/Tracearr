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
    referencedByNewsletterCount: 0,
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

      const violations = screen.getByLabelText('pages:settings.destinations.receiveViolations');
      if (kind === 'email') {
        expect(violations).not.toBeChecked();
        expect(violations).toBeDisabled();
      } else {
        expect(violations).toBeChecked();
        expect(violations).toBeEnabled();
      }
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

  it('refuses to save an unfilled form, shows what is missing, then saves once filled', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pickType(user, 'discord');

    const save = screen.getByRole('button', { name: 'common:actions.save' });
    expect(screen.queryByText('common:validation.required')).not.toBeInTheDocument();

    await user.click(save);
    expect(createAsync).not.toHaveBeenCalled();
    expect(screen.getAllByText('common:validation.required')).toHaveLength(1);
    expect(screen.getByLabelText(/fields\.webhookUrl/)).toHaveAttribute('aria-invalid', 'true');

    await user.type(
      screen.getByLabelText(/fields\.webhookUrl/),
      'https://discord.com/api/webhooks/1/x'
    );
    expect(screen.queryByText('common:validation.required')).not.toBeInTheDocument();

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
    const userKey = screen.getByLabelText(/fields\.userKey/);
    expect(userKey).not.toHaveAttribute('placeholder', 'pages:settings.destinations.secretSet');

    await user.click(save);
    expect(updateAsync).not.toHaveBeenCalled();
    expect(screen.getAllByText('common:validation.required')).toHaveLength(2);

    await user.type(userKey, 'u');
    await user.type(screen.getByLabelText(/fields\.apiToken/), 't');
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

  it('shows the resend username hint after picking the preset, and the generic hint for custom', async () => {
    const user = await openEmail();
    expect(
      screen.getByText('pages:settings.destinations.hints.smtpUsernameOptional')
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText(label('preset')));
    await user.click(
      screen.getByRole('option', { name: 'pages:settings.destinations.options.presetResend' })
    );
    expect(
      screen.getByText('pages:settings.destinations.hints.smtpResendUsername')
    ).toBeInTheDocument();
    expect(
      screen.queryByText('pages:settings.destinations.hints.smtpUsernameOptional')
    ).not.toBeInTheDocument();
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

  it('describes what an email destination is for, under the title', async () => {
    await openEmail();
    expect(screen.getByText('pages:settings.destinations.emailDescription')).toBeInTheDocument();
    expect(screen.queryByText('pages:settings.destinations.description')).not.toBeInTheDocument();
  });

  it('renders the three group fieldsets in order with a separator before each', async () => {
    await openEmail();
    const labels = screen.getAllByText(/pages:settings\.destinations\.groups\./);
    expect(labels.map((el) => el.textContent)).toEqual([
      'pages:settings.destinations.groups.connection',
      'pages:settings.destinations.groups.sender',
      'pages:settings.destinations.groups.alerts',
    ]);
    for (const el of labels) {
      expect(el.tagName).toBe('LEGEND');
      const fieldset = el.closest('fieldset');
      expect(fieldset).toHaveAttribute('data-slot', 'field-set');
      expect(fieldset?.previousElementSibling).toHaveAttribute('data-slot', 'field-separator');
    }
  });

  it('starts with no events and no way to subscribe until an alert address is typed', async () => {
    const user = await openEmail();
    const violations = screen.getByLabelText('pages:settings.destinations.receiveViolations');
    expect(violations).toBeDisabled();
    expect(
      screen.getByText('pages:settings.destinations.receiveViolationsNeedsRecipients')
    ).toBeInTheDocument();

    await user.type(screen.getByLabelText(label('host')), 'smtp.example.com');
    await user.type(screen.getByLabelText(label('fromAddress')), 'plex@example.com');
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));
    expect(createAsync).toHaveBeenLastCalledWith(expect.objectContaining({ events: [] }));

    await user.type(screen.getByLabelText(label('to')), 'a@example.com');
    expect(violations).toBeEnabled();
    expect(
      screen.getByText('pages:settings.destinations.receiveViolationsHint')
    ).toBeInTheDocument();
    await user.click(violations);
    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));
    expect(createAsync).toHaveBeenLastCalledWith(
      expect.objectContaining({ events: ['violation_detected'] })
    );
  });

  it('turns the switch off and saves no events once an existing list is cleared', async () => {
    const user = userEvent.setup();
    render(
      <DestinationDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        destination={destination({
          type: 'email',
          events: ['violation_detected'],
          config: {
            preset: 'custom',
            host: 'smtp.example.com',
            port: '587',
            security: 'starttls',
            username: null,
            password: null,
            fromName: 'Tracearr',
            fromAddress: 'plex@example.com',
            replyTo: null,
            to: 'a@example.com',
            messagesPerSecond: '2',
          },
          secretsSet: [],
        })}
      />
    );

    const violations = screen.getByLabelText('pages:settings.destinations.receiveViolations');
    expect(violations).toBeChecked();

    await user.clear(screen.getByLabelText(label('to')));
    expect(violations).not.toBeChecked();
    expect(violations).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));
    expect(updateAsync).toHaveBeenCalledWith({
      id: 'dest-1',
      data: expect.objectContaining({ events: [], config: { to: null } }),
    });
  });

  it('opens straight on the email form when given initialKind', () => {
    render(<DestinationDialog open onOpenChange={vi.fn()} mode="create" initialKind="email" />);

    expect(
      screen.queryByRole('button', { name: 'pages:settings.destinations.types.discord' })
    ).not.toBeInTheDocument();
    expect(screen.getByLabelText(label('host'))).toBeInTheDocument();
    expect(screen.getByLabelText(/^common:labels\.name/)).toHaveValue(
      'pages:settings.destinations.types.email'
    );
    expect(screen.getByText('pages:settings.destinations.emailDescription')).toBeInTheDocument();
  });

  it('ignores initialKind in edit mode and keeps the edited destination kind', () => {
    render(
      <DestinationDialog
        open
        onOpenChange={vi.fn()}
        mode="edit"
        destination={destination()}
        initialKind="email"
      />
    );

    expect(screen.getByLabelText(/fields\.userKey/)).toBeInTheDocument();
    expect(screen.queryByLabelText(label('host'))).not.toBeInTheDocument();
  });
});

describe('DestinationDialog layout and error gating', () => {
  const label = (key: string) => new RegExp(`pages:settings\\.destinations\\.fields\\.${key}\\b`);

  it('opens quiet and only marks a required field once it is left blank', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pickType(user, 'email');

    expect(screen.queryByText('common:validation.required')).not.toBeInTheDocument();
    expect(screen.getByLabelText(label('host'))).toHaveAttribute('aria-invalid', 'false');

    await user.click(screen.getByLabelText(label('host')));
    await user.tab();

    expect(screen.getAllByText('common:validation.required')).toHaveLength(1);
    expect(screen.getByLabelText(label('host'))).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(label('fromAddress'))).toHaveAttribute('aria-invalid', 'false');
  });

  it('marks every missing required field once Save is clicked', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pickType(user, 'email');

    await user.click(screen.getByRole('button', { name: 'common:actions.save' }));

    // The name is prefilled from the kind, so host and from address are the two left.
    expect(screen.getAllByText('common:validation.required')).toHaveLength(2);
    expect(createAsync).not.toHaveBeenCalled();
  });

  it('marks the name field once it is blanked and left', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pickType(user, 'discord');

    const name = screen.getByLabelText(/^common:labels\.name/);
    await user.clear(name);
    expect(screen.queryByText('common:validation.required')).not.toBeInTheDocument();
    await user.tab();
    expect(screen.getAllByText('common:validation.required')).toHaveLength(1);
    expect(name).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps the footer outside the scrolling body', async () => {
    const user = userEvent.setup();
    renderCreate();
    await pickType(user, 'discord');

    const body = screen.getByLabelText(/fields\.webhookUrl/).closest('.overflow-y-auto');
    const footer = screen
      .getByRole('button', { name: 'common:actions.save' })
      .closest('[data-slot="dialog-footer"]');
    expect(body).not.toBeNull();
    expect(footer).not.toBeNull();
    expect(body?.contains(footer)).toBe(false);
    expect(screen.getByRole('dialog')).toHaveClass('flex', 'flex-col', 'overflow-hidden');
    expect(footer).toHaveClass('border-t');
  });
});
