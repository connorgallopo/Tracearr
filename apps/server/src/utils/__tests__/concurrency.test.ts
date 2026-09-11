import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../concurrency.js';

function gate(name: string) {
  let release: () => void = () => {};
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { name, opened, open: () => release() };
}

describe('mapWithConcurrency', () => {
  it('returns results in input order regardless of completion order', async () => {
    const [a, b, c] = [gate('a'), gate('b'), gate('c')];
    const run = mapWithConcurrency([a, b, c], 3, async (g) => {
      await g.opened;
      return g.name;
    });
    c.open();
    a.open();
    b.open();
    await expect(run).resolves.toEqual(['a', 'b', 'c']);
  });

  it('never has more than the limit in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight -= 1;
      return n * 2;
    });
    expect(result).toEqual([2, 4, 6, 8, 10]);
    expect(peak).toBe(2);
  });

  it('resolves to an empty array for no items', async () => {
    await expect(mapWithConcurrency([], 4, async () => 1)).resolves.toEqual([]);
  });
});
