import { renderDigest, type EmailBranding, type RenderedEmail } from '@tracearr/emails';
import type { NewsletterSectionCounts } from '@tracearr/shared';
import type { PosterRef } from '../../db/schema.js';
import { createLogger } from '../../utils/logger.js';
import { sectionItemCounts, type DigestData } from './assemble.js';
import {
  buildDigestInput,
  substitutePosterRefs,
  type DigestInputOptions,
  type ResolvedImageMode,
} from './render.js';

const logger = createLogger('newsletter-fit');

/** Gmail clips a message whose html part passes this many bytes. */
export const EMAIL_CLIP_BUDGET_BYTES = 102_400;
/** Room for the per-recipient unsubscribe and view links delivery writes over the placeholders: 235 B at a 40-character external URL. */
export const EMAIL_CLIP_MARGIN_BYTES = 1_024;
export const EMAIL_CLIP_FIT_BYTES = EMAIL_CLIP_BUDGET_BYTES - EMAIL_CLIP_MARGIN_BYTES;

export type TrimmableSection = keyof NewsletterSectionCounts;

/** Ties go to the section whose item costs the most bytes, so the fewest items leave: a show card (3.3 KB) before a movie card (1.9 KB), an artist card (1.7 KB), a most-watched row (1.7 KB). */
export const TRIM_ORDER: readonly TrimmableSection[] = ['shows', 'movies', 'albums', 'mostWatched'];

export const NO_TRIM: NewsletterSectionCounts = Object.freeze({
  movies: 0,
  shows: 0,
  albums: 0,
  mostWatched: 0,
});

export function sectionToTrim(data: DigestData): TrimmableSection | null {
  const counts = sectionItemCounts(data);
  let pick: TrimmableSection | null = null;
  for (const section of TRIM_ORDER) {
    if (counts[section] > 0 && (pick === null || counts[section] > counts[pick])) pick = section;
  }
  return pick;
}

/** A new DigestData without the section's last item; counts stay, so the section's "+N more" grows by one. */
export function dropLastItem(data: DigestData, section: TrimmableSection): DigestData {
  if (section === 'movies') return { ...data, movies: data.movies.slice(0, -1) };
  if (section === 'shows') return { ...data, shows: data.shows.slice(0, -1) };
  if (section === 'mostWatched') return { ...data, mostWatched: data.mostWatched.slice(0, -1) };
  const artists = data.artists.map((artist) => ({ ...artist, albums: [...artist.albums] }));
  const last = artists[artists.length - 1];
  if (!last) return data;
  last.albums.pop();
  if (last.albums.length === 0) artists.pop();
  return { ...data, artists };
}

export interface FitMeasure {
  rendered: RenderedEmail;
  bytes: number;
}

export interface FitResult {
  rendered: RenderedEmail;
  data: DigestData;
  bytes: number;
  trimmed: NewsletterSectionCounts;
  renders: number;
}

/** Renders and measures, removing one item at a time from the largest section until the measure fits; the item count bounds the renders. */
export async function fitDigest(
  data: DigestData,
  measure: (data: DigestData) => Promise<FitMeasure>
): Promise<FitResult> {
  const items = sectionItemCounts(data);
  const limit = items.movies + items.shows + items.albums + items.mostWatched;
  const trimmed: NewsletterSectionCounts = { ...NO_TRIM };
  let current = data;
  let renders = 0;
  for (;;) {
    const { rendered, bytes } = await measure(current);
    renders += 1;
    const section =
      bytes > EMAIL_CLIP_FIT_BYTES && renders <= limit ? sectionToTrim(current) : null;
    if (!section) return { rendered, data: current, bytes, trimmed, renders };
    const before = sectionItemCounts(current)[section];
    current = dropLastItem(current, section);
    // A hand-built digest can still hand this an artist with no albums; credit only the albums actually gone.
    trimmed[section] += before - sectionItemCounts(current)[section];
  }
}

/** The bytes a recipient's client sees, before the two per-recipient links: poster refs replaced the way delivery replaces them. */
export function deliveredBytes(
  html: string,
  posters: Record<string, PosterRef>,
  mode: ResolvedImageMode,
  externalUrl: string | null
): number {
  return Buffer.byteLength(substitutePosterRefs(html, posters, mode, externalUrl), 'utf8');
}

export interface FitDelivery {
  newsletterId: string;
  mode: ResolvedImageMode;
  externalUrl: string | null;
}

/** The one render entry for preview, test and scheduled sends; what it returns is what delivery substitutes and sends. */
export async function renderDigestToFit(
  data: DigestData,
  posters: Record<string, PosterRef>,
  opts: DigestInputOptions,
  branding: EmailBranding,
  delivery: FitDelivery
): Promise<FitResult> {
  const result = await fitDigest(data, async (current) => {
    const rendered = await renderDigest(buildDigestInput(current, posters, opts), branding);
    return {
      rendered,
      bytes: deliveredBytes(rendered.html, posters, delivery.mode, delivery.externalUrl),
    };
  });
  if (result.bytes > EMAIL_CLIP_FIT_BYTES) {
    logger.warn('Digest still exceeds the clip budget after trimming everything it could', {
      newsletterId: delivery.newsletterId,
      bytes: result.bytes,
      budget: EMAIL_CLIP_FIT_BYTES,
    });
  } else if (result.renders > 1) {
    logger.debug('Trimmed the digest to fit the clip budget', {
      newsletterId: delivery.newsletterId,
      trimmed: result.trimmed,
      bytes: result.bytes,
      renders: result.renders,
    });
  }
  return result;
}
