import { describe, it, expect } from 'vitest';
import { DEFAULT_NEWSLETTER_SECTIONS, type NewsletterPreview } from '@tracearr/shared';
import {
  countsListedLine,
  defaultVariantKey,
  heldBack,
  previewVariants,
  sendSummary,
  windowLabel,
} from './previewSummary';

const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

const preview: NewsletterPreview = {
  window: {
    start: '2026-08-28T00:00:00.000Z',
    end: '2026-09-04T00:00:00.000Z',
    fromWatermark: false,
  },
  recipients: { resolved: 42, missingEmail: 2, suppressed: 1 },
  variants: [
    {
      key: 's-1',
      serverIds: ['s-1'],
      serverNames: ['Basement'],
      recipientCount: 42,
      subject: 'x',
      html: '<p/>',
      counts: { movies: 12, shows: 3, episodes: 30, albums: 0, mostWatched: 0 },
      trimmed: { movies: 0, shows: 0, albums: 0, mostWatched: 0 },
    },
  ],
};

describe('previewSummary', () => {
  it('formats a window date as month and day', () => {
    expect(windowLabel('2026-08-28T12:00:00.000Z', 'en-US', 'UTC')).toBe('Aug 28');
  });

  it('builds the one-sentence confirmation', () => {
    expect(sendSummary(preview, t, 'en-US', 'UTC')).toBe(
      'newsletters.editor.send.summary:{"count":42,"counts":"newsletters.counts.movies:{\\"count\\":12}, newsletters.counts.shows:{\\"count\\":3}, newsletters.counts.albums:{\\"count\\":0}","start":"Aug 28","end":"Sep 4"}'
    );
  });

  it('adds the items the size budget folded into +N more lines', () => {
    const trimmed: NewsletterPreview = {
      ...preview,
      variants: [
        { ...preview.variants[0], trimmed: { movies: 0, shows: 1, albums: 2, mostWatched: 0 } },
      ],
    };
    expect(sendSummary(trimmed, t, 'en-US', 'UTC')).toBe(
      'newsletters.editor.send.summary:{"count":42,"counts":"newsletters.counts.movies:{\\"count\\":12}, newsletters.counts.shows:{\\"count\\":3}, newsletters.counts.albums:{\\"count\\":0}","start":"Aug 28","end":"Sep 4"} newsletters.editor.send.trimmed:{"count":3}'
    );
  });

  it('hides a union nobody receives and opens on the variant with the most people', () => {
    const union = { ...preview.variants[0], key: 'a,b', recipientCount: 0 };
    const a = { ...preview.variants[0], key: 'a', recipientCount: 3 };
    const b = { ...preview.variants[0], key: 'b', recipientCount: 9 };
    expect(previewVariants([union, a, b]).map((v) => v.key)).toEqual(['a', 'b']);
    expect(defaultVariantKey(previewVariants([union, a, b]))).toBe('b');
    expect(previewVariants([union]).map((v) => v.key)).toEqual(['a,b']);
    const peopled = { ...union, recipientCount: 2 };
    expect(previewVariants([peopled, a]).map((v) => v.key)).toEqual(['a,b', 'a']);
    expect(defaultVariantKey([peopled, a])).toBe('a');
  });

  it('says how many of the titles found the email lists, per enabled section, and counts what was held back', () => {
    const variant = {
      ...preview.variants[0],
      counts: { movies: 19, shows: 3, episodes: 30, albums: 5, mostWatched: 10 },
      trimmed: { movies: 2, shows: 0, albums: 0, mostWatched: 1 },
    };
    const sections = {
      ...DEFAULT_NEWSLETTER_SECTIONS,
      mostWatched: { enabled: true, max: 10 },
    };
    expect(countsListedLine(variant, sections, t)).toBe(
      'newsletters.editor.preview.countsListed.movies:{"listed":10,"found":19}, newsletters.editor.preview.countsListed.shows:{"listed":3,"found":3}, newsletters.editor.preview.countsListed.albums:{"listed":5,"found":5}, newsletters.counts.watched:{"count":9}'
    );
    expect(
      countsListedLine(variant, { ...sections, music: { enabled: false, max: 8 } }, t)
    ).not.toContain('albums');
    expect(heldBack(variant.trimmed)).toBe(3);
  });
});
