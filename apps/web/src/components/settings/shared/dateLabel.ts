import { format } from 'date-fns';
import { getDateTimeFormatString, getHour12 } from '@/lib/timeFormat';

/** The current year is implied; anything older says which year it came from. */
export function dateLabel(iso: string): string {
  const date = new Date(iso);
  const pattern = getDateTimeFormatString();
  return format(
    date,
    date.getFullYear() === new Date().getFullYear()
      ? pattern
      : pattern.replace('MMM d,', 'MMM d, yyyy,')
  );
}

/** The calendar year an instant falls in inside the given zone, which is not always the browser's. */
const yearIn = (date: Date, timeZone: string): string =>
  new Intl.DateTimeFormat('en', { timeZone, year: 'numeric' }).format(date);

/** dateLabel in a named zone instead of the browser's: the newsletter's schedule is stored in its own zone. */
export function zonedDateLabel(iso: string, timeZone: string, locale?: string): string {
  const date = new Date(iso);
  const sameYear = yearIn(date, timeZone) === yearIn(new Date(), timeZone);
  return (
    new Intl.DateTimeFormat(locale, {
      timeZone,
      month: 'short',
      day: 'numeric',
      ...(sameYear ? {} : { year: 'numeric' }),
      hour: 'numeric',
      minute: '2-digit',
      hour12: getHour12(),
    })
      .format(date)
      // ICU 72+ puts a narrow no-break space before AM; date-fns, which every other label uses, puts a plain one.
      .replace(/\u202f/g, ' ')
  );
}
