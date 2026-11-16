import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { GenreRow } from '@tracearr/shared';
import { GenreStatCards } from './GenreStatCards';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));

function row(genre: string, plays: number, priorPlays: number | null): GenreRow {
  return {
    genre,
    itemCount: 20,
    sizeBytes: 0,
    plays,
    priorPlays,
    watchTimeMs: 0,
    finishedRate: null,
    topViewer: null,
    neverPlayed: { count: 0, bytes: 0 },
    trend: [],
  };
}

const ROWS = [
  row('Comedy', 30, 15),
  row('Action', 12, 20),
  row('Drama', 10, 9),
  row('Horror', 8, 8),
  row('Western', 5, null),
  row('Music', 5, 6),
  row('Kids', 0, 0),
];

function card(label: string) {
  return screen.getByText(label, { exact: false }).closest('.bg-card');
}

describe('GenreStatCards', () => {
  it('counts genres with plays, measures the top five against all genre plays, and names the largest moves', () => {
    render(<GenreStatCards rows={ROWS} />);

    expect(card('pages:media.genres.cards.withPlays')).toHaveTextContent(
      '6pages:media.genres.cards.ofGenres:{"count":7}'
    );
    // 65 of the 70 plays every genre holds; a total-plays denominator would read differently.
    expect(card('pages:media.genres.cards.topFiveShare')).toHaveTextContent(/^93%/);

    const rise = card('pages:media.genres.cards.largestRise');
    expect(rise).toHaveTextContent('+15+100%pages:userDetail.cards.vsPrior');
    expect(rise).toHaveTextContent('pages:media.genres.cards.largestRise · Comedy');

    const fall = card('pages:media.genres.cards.largestFall');
    expect(fall).toHaveTextContent('-8-40%pages:userDetail.cards.vsPrior');
    expect(fall).toHaveTextContent('pages:media.genres.cards.largestFall · Action');
  });
});
