export type FitPoint = [lon: number, lat: number, weight?: number];

const OUTLIER_SHARE = 0.01;
const OUTLIER_GAP = 0.5;
const OUTLIER_MIN_GAP_DEGREES = 30;

/**
 * Indexes of the points at one end of an axis that sit past a gap of at least
 * half the axis and 30 degrees, and together hold under 1% of the weight.
 */
function farTail(points: FitPoint[], axis: 0 | 1, fromHighEnd: boolean, total: number): number[] {
  const sorted = points
    .map((point, index) => ({ index, value: point[axis], weight: point[2] ?? 1 }))
    .sort((a, b) => (fromHighEnd ? b.value - a.value : a.value - b.value));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (!first || !last) return [];
  const extent = Math.abs(last.value - first.value);

  let weight = 0;
  let widestGap = 0;
  let cut = 0;
  let previous = first;
  for (const [i, entry] of sorted.entries()) {
    if (i === 0) continue;
    weight += previous.weight;
    if (weight > total * OUTLIER_SHARE) break;
    const gap = Math.abs(entry.value - previous.value);
    if (gap > widestGap) {
      widestGap = gap;
      cut = i;
    }
    previous = entry;
  }
  const isFar = widestGap >= OUTLIER_MIN_GAP_DEGREES && widestGap >= extent * OUTLIER_GAP;
  return isFar ? sorted.slice(0, cut).map((entry) => entry.index) : [];
}

/**
 * Box to fit the map to. A far-off place with a sliver of the plays is left
 * outside it, so one play on another continent cannot centre the view on
 * empty ocean. Points with no weight count as one each.
 */
export function autoFitBounds(
  points: FitPoint[]
): [[minLon: number, minLat: number], [maxLon: number, maxLat: number]] | null {
  if (points.length === 0) return null;
  const total = points.reduce((sum, point) => sum + (point[2] ?? 1), 0);
  const dropped = new Set([
    ...farTail(points, 0, false, total),
    ...farTail(points, 0, true, total),
    ...farTail(points, 1, false, total),
    ...farTail(points, 1, true, total),
  ]);
  const kept = points.filter((_, i) => !dropped.has(i));

  let [minLon, minLat, maxLon, maxLat] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of kept) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}
