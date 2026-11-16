import type Highcharts from 'highcharts';
import type { PlaysMediaGroup, Server } from '@tracearr/shared';
import { getFormatLocale } from '@/lib/dateFormat';

/**
 * Dates in the person's formatting locale. Highcharts would format numbers in that locale too,
 * so the browser's separators are pinned to keep numbers matching the rest of the app.
 */
export function chartLang(): Highcharts.LangOptions {
  const parts = new Intl.NumberFormat().formatToParts(1234567.5);
  return {
    locale: getFormatLocale(),
    decimalPoint: parts.find((part) => part.type === 'decimal')?.value,
    thousandsSep: parts.find((part) => part.type === 'group')?.value,
  };
}

/**
 * Build one Highcharts series per server in stable server order.
 * Rows not matching any server in `servers` are silently dropped.
 */
export function buildPerServerSeries<T extends { serverId: string }>(
  rows: T[],
  servers: Pick<Server, 'id' | 'name' | 'color'>[],
  getPoint: (row: T) => [number, number],
  opts?: { type?: 'area' | 'column'; stacking?: 'normal' }
): Highcharts.SeriesOptionsType[] {
  const type = opts?.type ?? 'area';
  const stacking = opts?.stacking ?? 'normal';

  return servers.map((server) => {
    const serverRows = rows
      .filter((r) => r.serverId === server.id)
      .map(getPoint)
      .sort((a, b) => a[0] - b[0]);

    return {
      type,
      name: server.name,
      color: server.color ?? undefined,
      stacking,
      data: serverRows,
    };
  });
}

/** Unordered categories (platforms, top lists) cycle these in order. */
export const CATEGORICAL_COLORS = [
  'oklch(var(--chart-1))',
  'oklch(var(--chart-2))',
  'oklch(var(--chart-3))',
  'oklch(var(--chart-4))',
  'oklch(var(--chart-5))',
  'oklch(var(--chart-6))',
  'oklch(var(--chart-7))',
  'oklch(var(--chart-8))',
] as const;

export const MEDIA_TYPE_COLORS = {
  movie: 'oklch(var(--media-movie))',
  show: 'oklch(var(--media-show))',
  music: 'oklch(var(--media-music))',
} as const;

export const PLAYBACK_COLORS = {
  directPlay: 'oklch(var(--playback-direct))',
  directStream: 'oklch(var(--playback-copy))',
  audioTranscode: 'oklch(var(--playback-audio))',
  transcode: 'oklch(var(--playback-transcode))',
} as const;

/** Fill for stacked areas: light enough that the series below and the grid show through. */
export const STACKED_AREA_FILL_OPACITY = 0.25;

/** Donut segments separated by the card color, so adjacent ramp steps stay apart. */
export const PIE_SEGMENT_BORDER = { borderWidth: 2, borderColor: 'oklch(var(--card))' } as const;

const MEDIA_GROUP_SERIES = [
  { group: 'movie', labelKey: 'common:media.movie_plural', color: MEDIA_TYPE_COLORS.movie },
  { group: 'show', labelKey: 'common:media.tvShows', color: MEDIA_TYPE_COLORS.show },
  { group: 'music', labelKey: 'common:media.music', color: MEDIA_TYPE_COLORS.music },
] as const satisfies readonly { group: PlaysMediaGroup; labelKey: string; color: string }[];

export interface MediaGroupSeries {
  labelKey: (typeof MEDIA_GROUP_SERIES)[number]['labelKey'];
  color: string;
  data: [number, number][];
}

/**
 * One series per media group in movie, show, music order, summed across servers at each x and
 * zero-filled over every x the rows carry. A group with no plays at any x is left out.
 */
export function buildMediaGroupSeries<T extends { mediaType?: PlaysMediaGroup; count: number }>(
  rows: T[],
  getX: (row: T) => number
): MediaGroupSeries[] {
  const xs = [...new Set(rows.map(getX))].sort((a, b) => a - b);
  return MEDIA_GROUP_SERIES.flatMap(({ group, labelKey, color }) => {
    const sums = new Map<number, number>();
    for (const row of rows) {
      if (row.mediaType !== group) continue;
      const x = getX(row);
      sums.set(x, (sums.get(x) ?? 0) + row.count);
    }
    if (![...sums.values()].some((count) => count > 0)) return [];
    return [{ labelKey, color, data: xs.map((x): [number, number] => [x, sums.get(x) ?? 0]) }];
  });
}

/** Shared-tooltip body: one colored line per series. */
export function sharedTooltipRows(points: Highcharts.Point[]): string {
  return points
    .map((p) => `<span style="color:${p.color}">●</span> ${p.series.name}: <b>${p.y}</b>`)
    .join('<br/>');
}

/** Shared-tooltip body for stacked series, closed by the stack total. */
export function stackedTooltipRows(points: Highcharts.Point[], totalLabel: string): string {
  const total = points.find((p) => p.total !== undefined)?.total ?? 0;
  return `${sharedTooltipRows(points)}<br/>${totalLabel}: <b>${total}</b>`;
}
