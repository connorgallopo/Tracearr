import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import type { Destination } from '@tracearr/shared';
import { DestinationRow } from '../DestinationRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock('@/hooks/queries/useDestinations', () => ({
  useUpdateDestination: vi.fn(),
  useDeleteDestination: vi.fn(),
  useTestDestination: vi.fn(),
}));

import {
  useDeleteDestination,
  useTestDestination,
  useUpdateDestination,
} from '@/hooks/queries/useDestinations';

function mutationResult<T>(): T {
  return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false } as unknown as T;
}

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'dest-email',
    name: 'Ops mail',
    type: 'email',
    enabled: true,
    builtin: false,
    events: [],
    configStatus: 'ok',
    config: {
      preset: 'custom',
      host: 'smtp.example.com',
      port: '587',
      security: 'starttls',
      username: null,
      password: null,
      fromName: 'Tracearr',
      fromAddress: 'news@example.com',
      replyTo: null,
      to: 'a@example.com, b@example.org',
      messagesPerSecond: '2',
    },
    secretsSet: [],
    referencedByAutomationCount: 0,
    referencedByNewsletterCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderRow(row: Destination) {
  const { container } = render(<DestinationRow destination={row} onEdit={vi.fn()} />);
  return within(container).getByRole('listitem');
}

beforeEach(() => {
  vi.mocked(useUpdateDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useUpdateDestination>>()
  );
  vi.mocked(useDeleteDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useDeleteDestination>>()
  );
  vi.mocked(useTestDestination).mockReturnValue(
    mutationResult<ReturnType<typeof useTestDestination>>()
  );
});

describe('DestinationRow', () => {
  it('shows the from address and how many addresses alerts go to', () => {
    const row = renderRow(destination());

    expect(row).toHaveTextContent(
      'news@example.com · pages:settings.destinations.alertsGoTo:{"count":2}'
    );
  });

  it('reads newsletters-only when the list is empty and a newsletter uses it', () => {
    const row = renderRow(
      destination({
        config: { ...destination().config, to: '' },
        referencedByNewsletterCount: 2,
      })
    );

    expect(row).toHaveTextContent('pages:settings.destinations.newslettersOnly');
    expect(row).toHaveTextContent('pages:settings.destinations.usedByNewsletters:{"count":2}');
    expect(row).not.toHaveTextContent(/destinations\.usedBy:/);
  });

  it('reads no alert recipients when the list is empty and nothing uses it', () => {
    const row = renderRow(destination({ config: { ...destination().config, to: null } }));

    expect(row).toHaveTextContent('pages:settings.destinations.noAlertRecipients');
    expect(row).not.toHaveTextContent(/destinations\.usedBy/);
  });

  it('lists automations and newsletters on the meta line when both use it', () => {
    renderRow(destination({ referencedByAutomationCount: 1, referencedByNewsletterCount: 3 }));

    expect(
      screen.getByText(
        'pages:settings.destinations.violationsOff · pages:settings.destinations.usedBy:{"count":1} · pages:settings.destinations.usedByNewsletters:{"count":3}'
      )
    ).toBeInTheDocument();
  });

  it('says whether the destination gets violations', () => {
    expect(renderRow(destination({ events: ['violation_detected'] }))).toHaveTextContent(
      'pages:settings.destinations.violationsOn'
    );

    expect(renderRow(destination())).toHaveTextContent('pages:settings.destinations.violationsOff');
  });

  it('dims the whole row when the destination is switched off', () => {
    expect(renderRow(destination({ enabled: false }))).toHaveClass('opacity-60');
  });

  it('says nothing about mail on a row whose config no longer decrypts', () => {
    const row = renderRow(destination({ configStatus: 'reencrypt', config: null }));

    expect(row).toHaveTextContent('pages:settings.destinations.reencrypt');
    expect(row).not.toHaveTextContent(/noAlertRecipients|newslettersOnly|alertsGoTo/);
  });

  it('shows none of the email lines on another kind', () => {
    const row = renderRow(
      destination({
        id: 'dest-discord',
        type: 'discord',
        config: { webhookUrl: null },
        secretsSet: ['webhookUrl'],
      })
    );

    expect(row).toHaveTextContent('pages:settings.destinations.types.discord');
    expect(row).not.toHaveTextContent(/alertsGoTo|newslettersOnly|noAlertRecipients/);
  });
});
