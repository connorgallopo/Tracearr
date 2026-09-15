import { beforeAll, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { initI18n } from '@tracearr/translations';
import { RequestsSummary } from './RequestsSummary';

beforeAll(async () => {
  await initI18n({ lng: 'en' });
});

describe('RequestsSummary', () => {
  it('shows the totals, the approval rate and the median wait', () => {
    render(
      <RequestsSummary
        summary={{
          total: 12,
          approvalRate: 0.75,
          completed: 9,
          neverWatched: 3,
          medianWaitMs: 2 * 60 * 60 * 1000,
        }}
      />
    );

    expect(screen.getByText('12')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/median wait 2h/)).toBeInTheDocument();
  });
});
