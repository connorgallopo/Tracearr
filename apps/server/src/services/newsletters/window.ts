import { NEWSLETTER_WINDOW_MAX_DAYS, type NewsletterWindow } from '@tracearr/shared';

const DAY_MS = 86_400_000;

/** Start is the watermark or the fallback, never older than the floor and never after now. */
export function computeWindow(
  window: NewsletterWindow,
  lastWindowEnd: Date | null,
  now: Date
): { start: Date; end: Date } {
  const floor = new Date(now.getTime() - NEWSLETTER_WINDOW_MAX_DAYS * DAY_MS);
  let start =
    window.kind === 'fixed'
      ? new Date(now.getTime() - window.days * DAY_MS)
      : (lastWindowEnd ?? new Date(now.getTime() - window.fallbackDays * DAY_MS));
  if (start < floor) start = floor;
  if (start > now) start = now;
  return { start, end: now };
}
