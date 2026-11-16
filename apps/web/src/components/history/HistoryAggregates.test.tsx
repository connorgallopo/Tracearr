import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { HistoryAggregates as Aggregates } from '@tracearr/shared';
import { HistoryAggregates } from './HistoryAggregates';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const HOUR = 3_600_000;

function aggregates(overrides: Partial<Aggregates>): Aggregates {
  return {
    totalWatchTimeMs: 5 * HOUR,
    listenTimeMs: 0,
    playCount: 12,
    uniqueUsers: 3,
    uniqueContent: 9,
    ...overrides,
  };
}

describe('HistoryAggregates', () => {
  it('shows one watch time value when nothing was listened to', () => {
    render(<HistoryAggregates aggregates={aggregates({})} total={12} />);

    expect(screen.getByText('5h 0m')).toBeInTheDocument();
    expect(screen.queryByText(/common:labels\.listenTime/)).not.toBeInTheDocument();
  });

  it('takes listen time out of the watch value and shows it on a second line', () => {
    render(<HistoryAggregates aggregates={aggregates({ listenTimeMs: HOUR })} total={12} />);

    expect(screen.getByText('4h 0m')).toBeInTheDocument();
    expect(screen.getByText('common:labels.listenTime 1h 0m')).toBeInTheDocument();
  });
});
