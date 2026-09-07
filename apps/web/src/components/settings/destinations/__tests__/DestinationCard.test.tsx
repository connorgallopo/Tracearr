import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Destination } from '@tracearr/shared';
import { DestinationCard } from '../DestinationCard';

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

function renderCard(row: Destination) {
  return render(<DestinationCard destination={row} onEdit={vi.fn()} />);
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

describe('DestinationCard', () => {
  it('truncates a long name inside a row that may shrink', () => {
    renderCard(destination({ name: 'A destination name long enough to overflow' }));

    const title = screen.getByRole('heading', { level: 3 });
    expect(title).toHaveClass('truncate');
    expect(title.parentElement).toHaveClass('min-w-0');
  });

  it('shows the from address and how many addresses alerts go to', () => {
    renderCard(destination());

    expect(screen.getByText('news@example.com')).toBeInTheDocument();
    expect(
      screen.getByText('pages:settings.destinations.alertsGoTo:{"count":2}')
    ).toBeInTheDocument();
  });

  it('reads newsletters-only when the list is empty and a newsletter uses it', () => {
    renderCard(
      destination({
        config: { ...destination().config, to: '' },
        referencedByNewsletterCount: 2,
      })
    );

    expect(screen.getByText('pages:settings.destinations.newslettersOnly')).toBeInTheDocument();
    expect(
      screen.getByText('pages:settings.destinations.usedByNewsletters:{"count":2}')
    ).toBeInTheDocument();
    expect(screen.queryByText(/destinations\.usedBy:/)).not.toBeInTheDocument();
  });

  it('reads no alert recipients when the list is empty and nothing uses it', () => {
    renderCard(destination({ config: { ...destination().config, to: null } }));

    expect(screen.getByText('pages:settings.destinations.noAlertRecipients')).toBeInTheDocument();
    expect(screen.queryByText(/destinations\.usedBy/)).not.toBeInTheDocument();
  });

  it('lists automations and newsletters on two lines when both use it', () => {
    renderCard(destination({ referencedByAutomationCount: 1, referencedByNewsletterCount: 3 }));

    expect(screen.getByText('pages:settings.destinations.usedBy:{"count":1}')).toBeInTheDocument();
    expect(
      screen.getByText('pages:settings.destinations.usedByNewsletters:{"count":3}')
    ).toBeInTheDocument();
  });

  it('says nothing about mail on a row whose config no longer decrypts', () => {
    renderCard(destination({ configStatus: 'reencrypt', config: null }));

    expect(screen.getByText('pages:settings.destinations.reencrypt')).toBeInTheDocument();
    expect(
      screen.queryByText(/noAlertRecipients|newslettersOnly|alertsGoTo/)
    ).not.toBeInTheDocument();
  });

  it('shows none of the email lines on another kind', () => {
    renderCard(
      destination({
        id: 'dest-discord',
        type: 'discord',
        config: { webhookUrl: null },
        secretsSet: ['webhookUrl'],
      })
    );

    expect(
      screen.queryByText(/alertsGoTo|newslettersOnly|noAlertRecipients/)
    ).not.toBeInTheDocument();
  });
});
