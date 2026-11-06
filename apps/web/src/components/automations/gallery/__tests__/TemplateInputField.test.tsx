import { beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { initI18n } from '@tracearr/translations';
import type { Server, TemplateDefinition, TemplateInput } from '@tracearr/shared';
import { TemplateInputField } from '../TemplateInputField';
import { STREAM_STARTED } from './fixtures';

const { useUsers } = vi.hoisted(() => ({
  useUsers: vi.fn((..._args: unknown[]): { data: unknown } => ({ data: undefined })),
}));
vi.mock('@/hooks/queries/useUsers', () => ({ useUsers }));

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

const servers = [{ id: 'server-1', name: 'Beehive' }] as unknown as Server[];

const serverInput: TemplateInput = {
  key: 'server',
  kind: 'server',
  label: 'Server',
  required: false,
};

const pausedInput: TemplateInput = {
  key: 'minutes',
  kind: 'duration',
  unit: 'minutes',
  label: 'Paused for',
  required: false,
  default: 30,
  min: 1,
};

function renderField(onFocusInput: (key: string | null) => void, input = serverInput) {
  render(
    <TemplateInputField
      input={input}
      definition={STREAM_STARTED.version.definition}
      value=""
      onChange={() => undefined}
      servers={servers}
      boundServerId=""
      filterOptions={undefined}
      unitSystem="metric"
      invalid={false}
      onFocusInput={onFocusInput}
    />
  );
  return userEvent.setup();
}

describe('TemplateInputField focus', () => {
  it('holds the row while its picker is open, however the list takes focus', async () => {
    const onFocusInput = vi.fn();
    const user = renderField(onFocusInput);

    await user.click(screen.getByRole('combobox'));
    await screen.findByRole('option', { name: 'Beehive' });

    expect(onFocusInput.mock.calls.map((call) => call[0])).not.toContain(null);
    expect(onFocusInput).toHaveBeenLastCalledWith('server');
  });

  it('lets the row go once focus lands somewhere else', async () => {
    const onFocusInput = vi.fn();
    const user = renderField(onFocusInput);

    screen.getByRole('combobox').focus();
    onFocusInput.mockClear();
    await user.tab();

    expect(onFocusInput).toHaveBeenLastCalledWith(null);
  });
});

describe('TemplateInputField units', () => {
  it('puts the unit in the control, so the label does not have to carry it', () => {
    renderField(vi.fn(), pausedInput);

    const control = screen.getByRole('textbox');
    expect(control).toHaveValue('30');
    expect(control.closest('[data-slot="input-group"]')).toHaveTextContent('minutes');
    expect(screen.getByText('Paused for')).toBeInTheDocument();
  });
});

describe('TemplateInputField send text', () => {
  it("keeps a send title within the template input's own limit", () => {
    const headline: TemplateInput = {
      key: 'headline',
      kind: 'text',
      label: 'Headline',
      required: false,
      maxLength: 80,
    };
    const base = STREAM_STARTED.version.definition;
    const definition: TemplateDefinition = {
      ...base,
      actions: {
        actions: base.actions.actions.map((action) =>
          action.type === 'send' ? { ...action, title: { $input: 'headline' } } : action
        ),
      },
    };
    render(
      <TemplateInputField
        input={headline}
        definition={definition}
        value=""
        onChange={() => undefined}
        servers={servers}
        boundServerId=""
        filterOptions={undefined}
        unitSystem="metric"
        invalid={false}
        onFocusInput={() => undefined}
      />
    );

    expect(screen.getByRole('combobox')).toHaveAttribute('maxlength', '80');
  });
});

describe('TemplateInputField accounts', () => {
  it('offers every account on every server when the template binds no server', async () => {
    useUsers.mockImplementation(() => ({
      data: {
        data: [
          {
            id: 'account-plex',
            username: 'ada',
            identityName: 'Ada',
            identityServers: [
              { id: 'server-1', name: 'Beehive', serverUserId: 'account-plex', removedAt: null },
              { id: 'server-2', name: 'Hive', serverUserId: 'account-jf', removedAt: null },
              {
                id: 'server-3',
                name: 'Old',
                serverUserId: 'account-gone',
                removedAt: '2026-01-01',
              },
            ],
          },
        ],
      },
    }));
    const account: TemplateInput = {
      key: 'account',
      kind: 'account',
      label: 'Account',
      required: true,
    };
    const twoServers = [...servers, { id: 'server-2', name: 'Hive' }] as unknown as Server[];
    render(
      <TemplateInputField
        input={account}
        definition={STREAM_STARTED.version.definition}
        value=""
        onChange={() => undefined}
        servers={twoServers}
        boundServerId=""
        filterOptions={undefined}
        unitSystem="metric"
        invalid={false}
      />
    );

    await userEvent.setup().click(screen.getByRole('combobox'));

    expect(useUsers).toHaveBeenCalledWith(
      { serverId: undefined, pageSize: 100 },
      { enabled: true }
    );
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Ada · Beehive',
      'Ada · Hive',
    ]);
  });
});
