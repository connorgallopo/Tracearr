import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BackupListItem, BackupMetadata } from '@tracearr/shared';
import { RestoreCard } from './BackupSettings';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/lib/api', () => ({
  api: { backup: { getInfo: vi.fn().mockResolvedValue({}), restore: vi.fn() } },
}));

vi.mock('@/hooks/useMaintenanceMode', () => ({
  useMaintenanceMode: () => ({ restore: null }),
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
