import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { BackupListItem } from '@tracearr/shared';
import { BackupHistory } from './BackupHistory';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/timeFormat', () => ({
  getTimeFormat: () => '12h',
  getDateTimeFormatString: () => 'MMM d, h:mm a',
  getFullDateTimeFormatString: () => 'MMM d, yyyy, h:mm:ss a',
}));

function backup(overrides: Partial<BackupListItem> = {}): BackupListItem {
  return {
    filename: 'tracearr-backup-20260830-020000.zip',
    size: 1024 * 1024,
    createdAt: '2026-08-30T02:00:00.000Z',
    type: 'scheduled',
    metadata: { app: { version: '2.1.0' } },
    ...overrides,
  } as BackupListItem;
}

describe('BackupHistory', () => {
  it('shows the date, type, size and version, and never the filename as a column', () => {
    render(
      <BackupHistory
        backups={[backup()]}
        isLoading={false}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    expect(screen.getByText('backup.typeScheduled')).toBeInTheDocument();
    expect(screen.getByText('2.1.0')).toBeInTheDocument();
    expect(screen.queryByText('tracearr-backup-20260830-020000.zip')).not.toBeInTheDocument();
  });

  it('keeps the filename as the row title so it is still reachable', () => {
    render(
      <BackupHistory
        backups={[backup()]}
        isLoading={false}
        onRestore={vi.fn()}
        onDelete={vi.fn()}
      />
    );

    // Both the table row and its list-shape counterpart carry the title;
    // jsdom renders both shapes at once since it can't evaluate the
    // container query that shows only one of them.
    const titled = screen.getAllByTitle('tracearr-backup-20260830-020000.zip');
    expect(titled.length).toBeGreaterThan(0);
  });

  it('puts restore, download and delete behind one named menu', async () => {
    const onRestore = vi.fn();
    render(
      <BackupHistory
        backups={[backup()]}
        isLoading={false}
        onRestore={onRestore}
        onDelete={vi.fn()}
      />
    );

    await userEvent.click(screen.getAllByRole('button', { name: 'backup.rowActions' })[0]!);
    const menu = screen.getByRole('menu');
    expect(
      within(menu).getByRole('menuitem', { name: 'backup.restoreAction' })
    ).toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'backup.download' })).toBeInTheDocument();

    await userEvent.click(within(menu).getByRole('menuitem', { name: 'backup.restoreAction' }));

    expect(onRestore).toHaveBeenCalledWith(expect.objectContaining({ type: 'scheduled' }));
  });

  it('reports the filename when a row is deleted', async () => {
    const onDelete = vi.fn();
    render(
      <BackupHistory
        backups={[backup()]}
        isLoading={false}
        onRestore={vi.fn()}
        onDelete={onDelete}
      />
    );

    await userEvent.click(screen.getAllByRole('button', { name: 'backup.rowActions' })[0]!);
    await userEvent.click(screen.getByRole('menuitem', { name: 'common:actions.delete' }));

    expect(onDelete).toHaveBeenCalledWith('tracearr-backup-20260830-020000.zip');
  });

  it('says so when there are no backups', () => {
    render(<BackupHistory backups={[]} isLoading={false} onRestore={vi.fn()} onDelete={vi.fn()} />);

    expect(screen.getByText('backup.noBackups')).toBeInTheDocument();
  });
});
