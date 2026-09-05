import { describe, it, expect } from 'vitest';
import type { NewsletterPreview } from '@tracearr/shared';
import { sendSummary, windowLabel } from './previewSummary';

const t = (key: string, vars?: Record<string, unknown>) =>
  vars ? `${key}:${JSON.stringify(vars)}` : key;

const preview: NewsletterPreview = {
  subject: 'x',
  html: '<p/>',
  counts: { movies: 12, shows: 3, episodes: 30, albums: 0, mostWatched: 0 },
  trimmed: { movies: 0, shows: 0, albums: 0, mostWatched: 0 },
  window: { start: '2026-08-28T00:00:00.000Z', end: '2026-09-04T00:00:00.000Z' },
  recipients: { resolved: 42, missingEmail: 2, suppressed: 1 },
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
    const trimmed = { ...preview, trimmed: { movies: 0, shows: 1, albums: 2, mostWatched: 0 } };
    expect(sendSummary(trimmed, t, 'en-US', 'UTC')).toBe(
      'newsletters.editor.send.summary:{"count":42,"counts":"newsletters.counts.movies:{\\"count\\":12}, newsletters.counts.shows:{\\"count\\":3}, newsletters.counts.albums:{\\"count\\":0}","start":"Aug 28","end":"Sep 4"} newsletters.editor.send.trimmed:{"count":3}'
    );
  });
});
