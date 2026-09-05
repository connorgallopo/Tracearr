import type { NewsletterPreview } from '@tracearr/shared';
import { countsLine, type Translate } from '../newsletterFormat';

export function windowLabel(iso: string, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }).format(
    new Date(iso)
  );
}

/** "Send to 42 recipients: 12 movies, 3 shows, 0 albums added between Aug 28 and Sep 4", plus what the size budget folded into "+N more" lines. */
export function sendSummary(
  preview: NewsletterPreview,
  t: Translate,
  locale?: string,
  timeZone?: string
): string {
  const sentence = t('newsletters.editor.send.summary', {
    count: preview.recipients.resolved,
    counts: countsLine(preview.counts, t),
    start: windowLabel(preview.window.start, locale, timeZone),
    end: windowLabel(preview.window.end, locale, timeZone),
  });
  // Object.values(preview.trimmed) types as any[]: NewsletterSectionCounts has no index signature.
  const { movies, shows, albums, mostWatched } = preview.trimmed;
  const held = movies + shows + albums + mostWatched;
  return held === 0
    ? sentence
    : `${sentence} ${t('newsletters.editor.send.trimmed', { count: held })}`;
}
