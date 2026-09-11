import { format } from 'date-fns';
import type { MediaRequestEntry, MediaRequestStatus, RequestSeason } from '@tracearr/shared';
import { formatDuration } from '@/lib/formatters';

/** i18next's TFunction can't statically verify these dynamically built keys; callers pass their real `t` through this shape. */
export type Translate = (key: string, vars?: Record<string, unknown>) => string;

const DECLINED_STATUSES: MediaRequestStatus[] = ['declined', 'failed'];
const SAME_MINUTE_MS = 60 * 1000;

export function formatWait(
  waitMs: number | null,
  status: MediaRequestStatus,
  t: Translate
): string {
  if (DECLINED_STATUSES.includes(status)) return t('requests.wait.declined');
  if (waitMs === null) return t('requests.wait.pending');
  if (waitMs < SAME_MINUTE_MS) return t('requests.wait.sameMinute');
  return t('requests.wait.landed', {
    duration: formatDuration(waitMs, { style: 'compactShort' }),
  });
}

export function formatSeasons(seasons: RequestSeason[] | null, t: Translate): string | null {
  if (seasons === null) return null;
  if (seasons.length === 0) return t('requests.seasons.all');
  return seasons
    .map((season) => season.seasonNumber)
    .sort((a, b) => a - b)
    .map((number) => t('requests.seasons.item', { number }))
    .join(', ');
}

export function heroRequestLine(
  entry: MediaRequestEntry,
  name: string,
  t: Translate,
  dateFormat: string
): string {
  const date = format(new Date(entry.requestedAt), dateFormat);
  const tail = formatWait(entry.waitMs, entry.status, t);
  return t('requests.hero.line', { name, date, tail });
}
