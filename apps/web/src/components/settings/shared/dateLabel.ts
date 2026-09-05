import { format } from 'date-fns';
import { getDateTimeFormatString } from '@/lib/timeFormat';

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
