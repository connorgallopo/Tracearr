import { format } from 'date-fns';
import type { NewsletterSchedule, NewsletterSendOutcome } from '@tracearr/shared';
import { getTimeFormatString } from '@/lib/timeFormat';

/** i18next's TFunction can't statically verify the dynamically built keys here; callers pass their real `t` through this shape. */
export type Translate = (key: string, vars?: Record<string, unknown>) => string;

export type OutcomeVariant = 'success' | 'warning' | 'danger' | 'secondary' | 'outline';

export function outcomeVariant(outcome: NewsletterSendOutcome): OutcomeVariant {
  switch (outcome) {
    case 'sent':
      return 'success';
    case 'partial':
      return 'warning';
    case 'failed':
      return 'danger';
    case 'skipped_empty':
      return 'outline';
    case 'rendering':
    case 'sending':
      return 'secondary';
  }
}

/** "HH:MM" from the schedule shown in the app's 12- or 24-hour clock. */
export function formatClock(time: string): string {
  const [hours, minutes] = time.split(':').map(Number);
  const at = new Date(2026, 0, 1, hours ?? 0, minutes ?? 0);
  return format(at, getTimeFormatString());
}

/** 2026-08-30 is a Sunday, so day 0..6 lands on the matching weekday name. */
function weekdayName(dayOfWeek: number, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2026, 7, 30 + dayOfWeek))
  );
}

export function scheduleSummary(
  schedule: NewsletterSchedule,
  timezone: string,
  t: Translate,
  locale?: string
): string {
  let summary: string;
  switch (schedule.kind) {
    case 'daily':
      summary = t('newsletters.schedule.daily', { time: formatClock(schedule.time) });
      break;
    case 'weekly':
      summary = t('newsletters.schedule.weekly', {
        day: weekdayName(schedule.dayOfWeek, locale),
        time: formatClock(schedule.time),
      });
      break;
    case 'monthly':
      summary = t('newsletters.schedule.monthly', {
        day: schedule.dayOfMonth,
        time: formatClock(schedule.time),
      });
      break;
    case 'cron':
      summary = t('newsletters.schedule.cron', { expression: schedule.expression });
      break;
  }
  return t('newsletters.schedule.inZone', { summary, timezone });
}

export function countsLine(itemCounts: Record<string, number>, t: Translate): string {
  return (['movies', 'shows', 'albums'] as const)
    .map((section) => t(`newsletters.counts.${section}`, { count: itemCounts[section] ?? 0 }))
    .join(', ');
}
