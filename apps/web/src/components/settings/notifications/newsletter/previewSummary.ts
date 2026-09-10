import type {
  NewsletterPreview,
  NewsletterPreviewVariant,
  NewsletterSectionCounts,
  NewsletterSections,
} from '@tracearr/shared';
import { countsLine, type Translate } from '../newsletterFormat';

export function windowLabel(iso: string, locale?: string, timeZone?: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }).format(
    new Date(iso)
  );
}

/** Items the fit loop folded into "+N more" lines, across every section. */
export function heldBack(trimmed: NewsletterSectionCounts): number {
  // Object.values(trimmed) types as any[]: NewsletterSectionCounts has no index signature.
  const { movies, shows, albums, mostWatched } = trimmed;
  return movies + shows + albums + mostWatched;
}

/** "Send to 42 recipients: 12 movies, 3 shows, 0 albums added between Aug 28 and Sep 4", plus what the size budget folded into "+N more" lines. */
export function sendSummary(
  preview: NewsletterPreview,
  t: Translate,
  locale?: string,
  timeZone?: string
): string {
  const union = preview.variants[0];
  const sentence = t('newsletters.editor.send.summary', {
    count: preview.recipients.resolved,
    counts: countsLine(union.counts, t),
    start: windowLabel(preview.window.start, locale, timeZone),
    end: windowLabel(preview.window.end, locale, timeZone),
  });
  const held = heldBack(union.trimmed);
  return held === 0
    ? sentence
    : `${sentence} ${t('newsletters.editor.send.trimmed', { count: held })}`;
}

/** The union is planned first even when nobody holds every server; a preview should not open on it then. */
export function previewVariants<T extends { recipientCount: number }>(
  variants: readonly [T, ...T[]]
): T[] {
  const [union, ...rest] = variants;
  return union.recipientCount === 0 && rest.length > 0 ? rest : [union, ...rest];
}

export function defaultVariantKey(
  variants: readonly { key: string; recipientCount: number }[]
): string {
  let best = variants[0];
  for (const variant of variants) {
    if (best === undefined || variant.recipientCount > best.recipientCount) best = variant;
  }
  return best?.key ?? '';
}

/** counts are what the window found, before the caps and the fit loop; listed is what the email shows. Most watched is capped by its query, so only its listed count is known. */
export function countsListedLine(
  variant: Pick<NewsletterPreviewVariant, 'counts' | 'trimmed'>,
  sections: NewsletterSections,
  t: Translate
): string {
  const found = (key: string) => variant.counts[key] ?? 0;
  const listed = (key: string, cap: number, trimmed: number) => Math.min(found(key), cap) - trimmed;
  const parts: string[] = [];
  if (sections.movies.enabled)
    parts.push(
      t('newsletters.editor.preview.countsListed.movies', {
        listed: listed('movies', sections.movies.max, variant.trimmed.movies),
        found: found('movies'),
      })
    );
  if (sections.shows.enabled)
    parts.push(
      t('newsletters.editor.preview.countsListed.shows', {
        listed: listed('shows', sections.shows.max, variant.trimmed.shows),
        found: found('shows'),
      })
    );
  if (sections.music.enabled)
    parts.push(
      t('newsletters.editor.preview.countsListed.albums', {
        listed: listed('albums', sections.music.max, variant.trimmed.albums),
        found: found('albums'),
      })
    );
  if (sections.mostWatched.enabled)
    parts.push(
      t('newsletters.counts.watched', { count: found('mostWatched') - variant.trimmed.mostWatched })
    );
  return parts.join(', ');
}
