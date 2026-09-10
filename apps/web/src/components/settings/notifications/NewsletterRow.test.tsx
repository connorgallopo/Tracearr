import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Newsletter } from '@tracearr/shared';
import { NewsletterRow } from './NewsletterRow';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars ? `${key}:${JSON.stringify(vars)}` : key,
    i18n: { language: 'en-US' },
  }),
}));

const newsletter: Newsletter = {
  id: 'n-1',
  name: 'Weekly',
  enabled: true,
  destinationId: 'd-1',
  schedule: { kind: 'weekly', dayOfWeek: 1, time: '09:00' },
  timezone: 'Europe/Berlin',
  window: { kind: 'since_last_send', fallbackDays: 7 },
  scope: { serverIds: [], libraries: [] },
  sections: {
    movies: { enabled: true, max: 12 },
    shows: { enabled: true, max: 12, maxSeasonsPerShow: 8 },
    music: { enabled: true, max: 8 },
    mostWatched: { enabled: false, max: 10 },
  },
  subject: 's',
  senderName: null,
  intro: null,
  outro: null,
  recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
  imageMode: 'auto',
  skipWhenEmpty: true,
  links: { tracearr: false },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  lastSend: {
    id: 's-1',
    trigger: 'schedule',
    outcome: 'sent',
    windowStart: '2026-08-26T00:00:00.000Z',
    windowEnd: '2026-09-02T00:00:00.000Z',
    recipientCount: 42,
    itemCounts: { movies: 12, shows: 3, episodes: 30, albums: 0, mostWatched: 0 },
    error: null,
    startedAt: '2026-09-02T07:00:00.000Z',
    finishedAt: '2026-09-02T07:01:00.000Z',
    hasSnapshot: true,
    variants: [],
  },
  nextRunAt: '2026-09-07T07:00:00.000Z',
};

function renderRow(over: Partial<Newsletter> = {}) {
  const handlers = {
    onEdit: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
    onToggle: vi.fn(),
  };
  render(<NewsletterRow newsletter={{ ...newsletter, ...over }} toggling={false} {...handlers} />);
  return handlers;
}

describe('NewsletterRow', () => {
  it('is a list item with the name, the schedule, the next run and the last outcome with counts', () => {
    renderRow();
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('Weekly');
    expect(row).toHaveTextContent('newsletters.schedule.inZone');
    expect(row).toHaveTextContent('newsletters.editor.nextRun');
    expect(row).toHaveTextContent('9:00 AM","timezone":"Europe/Berlin"');
    expect(row).toHaveTextContent(
      'newsletters.lastSend:{"outcome":"newsletters.outcome.sent","count":42}'
    );
    expect(row).toHaveTextContent('newsletters.counts.movies:{"count":12}');
  });

  it('says so when a newsletter never ran', () => {
    renderRow({ lastSend: null, nextRunAt: null });
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('newsletters.neverSent');
    expect(row).toHaveTextContent('newsletters.noNextRun');
  });

  it('patches enabled from the switch without opening anything', async () => {
    const { onToggle } = renderRow();
    const toggle = screen.getByRole('switch', { name: 'newsletters.enabled' });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('offers edit, duplicate and delete from one named menu', async () => {
    const { onEdit, onDuplicate, onDelete } = renderRow();
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.rowActions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'common:actions.edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.rowActions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'newsletters.duplicate' }));
    expect(onDuplicate).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: 'newsletters.rowActions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'common:actions.delete' }));
    expect(onDelete).toHaveBeenCalledTimes(1);
  });
});
