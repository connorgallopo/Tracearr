import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Jobs } from './Jobs';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useSocket', () => ({ useSocket: () => ({ socket: null }) }));

vi.mock('@/lib/api', () => ({
  api: {
    maintenance: {
      getJobs: vi.fn(),
      getHistory: vi.fn(),
      getStats: vi.fn(),
      getProgress: vi.fn(),
      startJob: vi.fn(),
    },
  },
}));

import { api } from '@/lib/api';

const completedRun = {
  jobId: 'job-1',
  type: 'trust_recompute',
  state: 'completed',
  createdAt: '2026-09-01T00:00:00.000Z',
  result: { processed: 1200, updated: 4, errors: 0, durationMs: 5200 },
};

const failedRun = {
  jobId: 'job-2',
  type: 'library_sync',
  state: 'failed',
  createdAt: '2026-09-01T00:00:00.000Z',
  result: null,
};

function withHistory(history: unknown[]) {
  vi.mocked(api.maintenance.getJobs).mockResolvedValue({ jobs: [] } as never);
  vi.mocked(api.maintenance.getHistory).mockResolvedValue({ history } as never);
  vi.mocked(api.maintenance.getStats).mockResolvedValue({} as never);
  vi.mocked(api.maintenance.getProgress).mockResolvedValue({} as never);
}

describe('Jobs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens with the section header', async () => {
    withHistory([]);

    render(<Jobs />);

    expect(
      await screen.findByRole('heading', { level: 2, name: 'nav.sections.jobs' })
    ).toBeInTheDocument();
  });

  it('uses the shared empty state when nothing has run', async () => {
    withHistory([]);

    render(<Jobs />);

    expect(
      await screen.findByRole('heading', { level: 3, name: 'common:empty.noJobHistory' })
    ).toBeInTheDocument();
  });

  it('renders each history entry as one item row with its outcome and counts', async () => {
    withHistory([completedRun]);

    render(<Jobs />);

    const row = (await screen.findByText('trust recompute')).closest('[data-slot="item"]');
    expect(row).not.toBeNull();
    expect(row).toHaveTextContent('common:states.success');
    expect(row).toHaveTextContent('1,200');
  });

  it('tints a failed run with the destructive token, not a red literal', async () => {
    withHistory([failedRun]);

    render(<Jobs />);

    const row = (await screen.findByText('library sync')).closest('[data-slot="item"]');
    expect(row?.className).toContain('border-destructive/30');
    expect(row?.className).not.toContain('red-500');
  });
});
