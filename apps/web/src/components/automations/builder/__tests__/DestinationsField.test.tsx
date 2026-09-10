import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Destination } from '@tracearr/shared';
import { DestinationsField } from '../DestinationsField';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/components/settings/destinations/DestinationDialog', () => ({
  DestinationDialog: ({
    open,
    onCreated,
  }: {
    open: boolean;
    onCreated?: (created: { id: string }) => void;
  }) =>
    open ? (
      <button type="button" onClick={() => onCreated?.({ id: 'dest-new' })}>
        simulate created
      </button>
    ) : null,
}));

vi.mock('@/hooks/queries/useDestinations', () => ({
  useDestinations: vi.fn(),
  useCreateDestination: vi.fn(),
  useUpdateDestination: vi.fn(),
  useTestDestination: vi.fn(),
  useTestUnsavedDestination: vi.fn(),
}));

import { useDestinations } from '@/hooks/queries/useDestinations';

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'dest-discord',
    name: 'Alpha Discord',
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
  name: 'Zed Push',
  type: 'push',
  builtin: true,
  config: null,
  secretsSet: [],
});

function setDestinations(rows: Destination[], isLoading = false) {
  vi.mocked(useDestinations).mockReturnValue({
    data: rows,
    isLoading,
  } as unknown as ReturnType<typeof useDestinations>);
}

const onChange = vi.fn();

beforeEach(() => {
  onChange.mockReset();
});

describe('DestinationsField', () => {
  it('lists built-ins before the rest and marks the selected ones', () => {
    setDestinations([destination(), pushRow]);
    render(<DestinationsField value={['dest-push']} onChange={onChange} label="Destinations" />);

    const toggles = screen.getAllByRole('button', { name: /Discord|Push/ });
    expect(toggles.map((b) => b.textContent)).toEqual(['Zed Push', 'Alpha Discord']);
    expect(toggles[0]).toHaveAttribute('aria-pressed', 'true');
    expect(toggles[0]).toHaveAttribute('data-state', 'on');
    expect(toggles[1]).toHaveAttribute('aria-pressed', 'false');
    expect(toggles[1]).toHaveAttribute('data-state', 'off');
  });

  it('keeps an id that has no row of its own when a listed one is toggled', async () => {
    const user = userEvent.setup();
    setDestinations([destination()]);
    render(
      <DestinationsField value={['deadbeef-gone-1234']} onChange={onChange} label="Destinations" />
    );

    await user.click(screen.getByRole('button', { name: 'Alpha Discord' }));

    expect(onChange).toHaveBeenCalledWith(['deadbeef-gone-1234', 'dest-discord']);
  });

  it('adds and removes ids through onChange', async () => {
    const user = userEvent.setup();
    setDestinations([destination(), pushRow]);
    const { rerender } = render(
      <DestinationsField value={[]} onChange={onChange} label="Destinations" />
    );

    await user.click(screen.getByRole('button', { name: 'Alpha Discord' }));
    expect(onChange).toHaveBeenCalledWith(['dest-discord']);

    rerender(
      <DestinationsField value={['dest-discord']} onChange={onChange} label="Destinations" />
    );
    await user.click(screen.getByRole('button', { name: 'Alpha Discord' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('explains a disabled destination and still lets a rule keep it', async () => {
    const user = userEvent.setup();
    setDestinations([destination({ enabled: false })]);
    render(<DestinationsField value={[]} onChange={onChange} label="Destinations" />);

    const toggle = screen.getByRole('button', { name: 'Alpha Discord' });
    expect(toggle.className).toContain('opacity-60');

    await user.hover(toggle);
    expect(
      await screen.findAllByText('pages:automations.builder.destinationDisabled')
    ).not.toHaveLength(0);

    await user.click(toggle);
    expect(onChange).toHaveBeenCalledWith(['dest-discord']);
  });

  it('shows a deleted destination as a removable badge', async () => {
    const user = userEvent.setup();
    setDestinations([destination()]);
    render(
      <DestinationsField
        value={['dest-discord', 'deadbeef-gone-1234']}
        onChange={onChange}
        label="Destinations"
      />
    );

    expect(screen.getByText('deadbeef')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'common:actions.remove deadbeef' }));
    expect(onChange).toHaveBeenCalledWith(['dest-discord']);
  });

  it('offers the add button when there are no destinations and selects what the dialog creates', async () => {
    const user = userEvent.setup();
    setDestinations([]);
    render(<DestinationsField value={[]} onChange={onChange} label="Destinations" />);

    expect(screen.getByText('pages:automations.builder.noDestinations')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'pages:automations.builder.newDestination' })
    );
    await user.click(screen.getByRole('button', { name: 'simulate created' }));
    expect(onChange).toHaveBeenCalledWith(['dest-new']);
  });

  it('keeps a selected but disabled destination visibly selected', () => {
    setDestinations([destination({ enabled: false })]);
    render(<DestinationsField value={['dest-discord']} onChange={onChange} label="Destinations" />);
    const button = screen.getByRole('button', { name: /Alpha Discord/ });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button.className).toContain('opacity-60');
  });

  it('renders a skeleton while the list loads', () => {
    setDestinations([], true);
    const { container } = render(
      <DestinationsField value={[]} onChange={onChange} label="Destinations" />
    );

    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('dims an email destination with no alert recipients, says why, and still lets a rule pick it', async () => {
    const user = userEvent.setup();
    setDestinations([
      destination({
        id: 'dest-mail',
        name: 'Ops mail',
        type: 'email',
        config: { fromAddress: 'news@example.com', to: '' },
        secretsSet: [],
      }),
      destination({
        id: 'dest-mail-2',
        name: 'Alerts mail',
        type: 'email',
        config: { fromAddress: 'news@example.com', to: 'a@example.com' },
        secretsSet: [],
      }),
    ]);
    render(<DestinationsField value={[]} onChange={onChange} label="Destinations" />);

    const quiet = screen.getByRole('button', { name: 'Ops mail' });
    expect(quiet.className).toContain('opacity-60');
    expect(screen.getByRole('button', { name: 'Alerts mail' }).className).not.toContain(
      'opacity-60'
    );

    await user.hover(quiet);
    expect(
      await screen.findAllByText('pages:automations.builder.noAlertRecipientsTooltip')
    ).not.toHaveLength(0);

    await user.click(quiet);
    expect(onChange).toHaveBeenCalledWith(['dest-mail']);
  });

  it('does not dim an email destination mid-reencrypt with a null config', async () => {
    const user = userEvent.setup();
    setDestinations([
      destination({
        id: 'dest-mail-reencrypt',
        name: 'Reencrypting mail',
        type: 'email',
        config: null,
        secretsSet: [],
      }),
    ]);
    render(<DestinationsField value={[]} onChange={onChange} label="Destinations" />);

    const toggle = screen.getByRole('button', { name: 'Reencrypting mail' });
    expect(toggle.className).not.toContain('opacity-60');

    await user.hover(toggle);
    expect(
      screen.queryByText('pages:automations.builder.noAlertRecipientsTooltip')
    ).not.toBeInTheDocument();
  });

  it('does not dim a non-email destination that has no alert list', () => {
    setDestinations([
      destination({
        id: 'dest-push-empty',
        name: 'Quiet push',
        type: 'push',
        config: { to: '' },
        secretsSet: [],
      }),
    ]);
    render(<DestinationsField value={[]} onChange={onChange} label="Destinations" />);

    expect(screen.getByRole('button', { name: 'Quiet push' }).className).not.toContain(
      'opacity-60'
    );
  });

  it('shows the disabled tooltip, not the alert-recipients one, for a disabled email destination with no alert list', async () => {
    const user = userEvent.setup();
    setDestinations([
      destination({
        id: 'dest-mail-off',
        name: 'Off mail',
        type: 'email',
        enabled: false,
        config: { fromAddress: 'news@example.com', to: '' },
        secretsSet: [],
      }),
    ]);
    render(<DestinationsField value={[]} onChange={onChange} label="Destinations" />);

    const toggle = screen.getByRole('button', { name: 'Off mail' });
    expect(toggle.className).toContain('opacity-60');

    await user.hover(toggle);
    expect(
      await screen.findAllByText('pages:automations.builder.destinationDisabled')
    ).not.toHaveLength(0);
    expect(
      screen.queryByText('pages:automations.builder.noAlertRecipientsTooltip')
    ).not.toBeInTheDocument();
  });
});
