import { describe, expect, it } from 'vitest';
import { autoFitBounds, type FitPoint } from './autoFitBounds';

describe('autoFitBounds', () => {
  it('leaves out a place across a wide gap that holds under 1% of the plays', () => {
    const points: FitPoint[] = [
      [-123, 49, 4],
      [-118, 34, 29],
      [-74, 41, 700],
      [24, 60, 1],
    ];

    expect(autoFitBounds(points)).toEqual([
      [-123, 34],
      [-74, 49],
    ]);
  });

  it('keeps a small place that is not across a wide gap', () => {
    const points: FitPoint[] = [
      [-123, 49, 1],
      [-100, 40, 300],
      [-74, 41, 700],
    ];

    expect(autoFitBounds(points)).toEqual([
      [-123, 40],
      [-74, 49],
    ]);
  });

  it('keeps a far-off place that holds more than 1% of the plays', () => {
    const points: FitPoint[] = [
      [-74, 41, 90],
      [24, 38, 10],
    ];

    expect(autoFitBounds(points)).toEqual([
      [-74, 38],
      [24, 41],
    ]);
  });

  it('fits every point when none carries a weight', () => {
    const points: FitPoint[] = [
      [-74, 41],
      [2, 48],
      [139, 35],
    ];

    expect(autoFitBounds(points)).toEqual([
      [-74, 35],
      [139, 48],
    ]);
  });

  it('returns null for no points', () => {
    expect(autoFitBounds([])).toBeNull();
  });
});
