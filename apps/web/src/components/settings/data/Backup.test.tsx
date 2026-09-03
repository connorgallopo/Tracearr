import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupListItem, BackupMetadata, RestoreProgress } from '@tracearr/shared';
import { RestoreCard, RetentionField } from './Backup';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({
  api: { backup: { getInfo: vi.fn().mockResolvedValue({}), restore: vi.fn() } },
}));

const { maintenanceModeMock } = vi.hoisted(() => ({
  maintenanceModeMock: vi.fn(() => ({ restore: null as RestoreProgress | null })),
}));

vi.mock('@/hooks/useMaintenanceMode', () => ({
  useMaintenanceMode: maintenanceModeMock,
  MAINTENANCE_EVENT: 'maintenance',
}));

function backupItem(counts: BackupMetadata['counts']): BackupListItem {
  return {
    filename: 'tracearr-backup-20260821-000000.zip',
    size: 1024,
    createdAt: '2026-08-21T00:00:00.000Z',
    type: 'manual',
    metadata: {
      format: 1,
      createdAt: '2026-08-21T00:00:00.000Z',
      app: { version: '2.1.0', commit: 'abc', tag: 'v2.1.0' },
      database: {
        pgVersion: '17.4',
        migrationCount: 1,
        latestMigration: '0001',
        tableCount: 20,
        databaseSize: 2048,
        timescaleVersion: '2.17.0',
        timescaleToolkitVersion: null,
      },
      counts,
    },
  };
}

function renderCard(item: BackupListItem) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RestoreCard backup={item} onClose={vi.fn()} />
    </QueryClientProvider>
  );
}

/** The row is `<dt>label</dt><dd>value</dd>`, so the value is the label's next sibling. */
function valueFor(label: string): string {
  const term = screen.getByText(label);
  return term.nextElementSibling?.textContent?.trim() ?? '';
}

const baseCounts = { sessions: 1, users: 2, servers: 3, libraryItems: 4 };

afterEach(() => {
  maintenanceModeMock.mockReturnValue({ restore: null });
});

describe('RestoreCard automation count', () => {
  it('renders the automation count from a current manifest', () => {
    renderCard(backupItem({ ...baseCounts, automations: 7 }));

    expect(valueFor('backup.restore.automations')).toBe('7');
  });

  it('falls back to the rule count a pre-rename manifest carries', () => {
    renderCard(backupItem({ ...baseCounts, rules: 12 }));

    expect(valueFor('backup.restore.automations')).toBe('12');
  });

  it('shows zero when a manifest carries neither count', () => {
    renderCard(backupItem(baseCounts));

    expect(valueFor('backup.restore.automations')).toBe('0');
  });
});

describe('RestoreCard complete state', () => {
  it('tints the icon by coloring the alert, not the svg itself', () => {
    maintenanceModeMock.mockReturnValue({
      restore: { phase: 'complete', message: 'done', startedAt: '2026-01-01T00:00:00.000Z' },
    });

    renderCard(backupItem(baseCounts));

    const alert = screen.getByText('backup.restore.complete').closest('[data-slot="alert"]');
    expect(alert).toHaveClass('[&>svg]:text-success');
    expect(alert).not.toHaveClass('[&>svg]:text-current');
  });
});

describe('RetentionField', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces retention edits and settles once, 1s after the last keystroke', () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    render(<RetentionField retentionCount={7} onSettle={onSettle} isSaving={false} />);

    const input = screen.getByLabelText('backup.retentionCount');

    act(() => {
      fireEvent.change(input, { target: { value: '2' } });
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => {
      fireEvent.change(input, { target: { value: '25' } });
    });

    expect(onSettle).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect(onSettle).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });

    expect(onSettle).toHaveBeenCalledTimes(1);
    expect(onSettle).toHaveBeenCalledWith(25);
  });

  it('shows saving while the debounce is pending, not just while the mutation runs', () => {
    vi.useFakeTimers();
    render(<RetentionField retentionCount={7} onSettle={vi.fn()} isSaving={false} />);

    const input = screen.getByLabelText('backup.retentionCount');
    expect(screen.queryByText('Saving...')).not.toBeInTheDocument();

    act(() => {
      fireEvent.change(input, { target: { value: '25' } });
    });
    expect(screen.getByText('Saving...')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Saving...')).not.toBeInTheDocument();
  });

  it('never fires onSettle for the value it was mounted with', () => {
    vi.useFakeTimers();
    const onSettle = vi.fn();
    render(<RetentionField retentionCount={7} onSettle={onSettle} isSaving={false} />);

    act(() => {
      vi.advanceTimersByTime(5000);
    });

    expect(onSettle).not.toHaveBeenCalled();
  });
});
