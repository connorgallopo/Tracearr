import { describe, expect, it } from 'vitest';
import {
  isMinorRelease,
  releaseNotesFileSchema,
  releaseTagIssues,
  renderReleaseNotesMarkdown,
  type ReleaseNotesFile,
} from '../releaseNotes.js';

const minor: ReleaseNotesFile = {
  version: '2.3.0',
  date: '2026-09-20',
  headline: 'Seerr requests, newsletters, and email',
  upgradeWarning: 'Back up before upgrading',
  highlights: [
    {
      title: 'Requests',
      body: 'Link Seerr to a server and Tracearr mirrors its request history, read-only.',
      docs: 'https://docs.tracearr.com/configuration/requests',
    },
  ],
  changes: [
    {
      type: 'fix',
      text: 'plex metadata refreshes no longer trigger a sync every 30 seconds',
      refs: ['#1171'],
    },
    {
      type: 'new',
      text: 'request history on its own page',
      docs: 'https://docs.tracearr.com/configuration/requests',
    },
    { type: 'note', text: 'migrations 0097 to 0104, nothing destructive' },
  ],
};

describe('isMinorRelease', () => {
  it('is true only for stable x.y.0', () => {
    expect(isMinorRelease('2.3.0')).toBe(true);
    expect(isMinorRelease('v3.0.0')).toBe(true);
    expect(isMinorRelease('2.3.1')).toBe(false);
    expect(isMinorRelease('2.3.0-beta.1')).toBe(false);
  });
});

describe('releaseNotesFileSchema', () => {
  it('accepts a full minor file', () => {
    expect(releaseNotesFileSchema.safeParse(minor).success).toBe(true);
  });

  it('accepts an in-progress x.y.0 with no headline or highlights', () => {
    const { headline: _headline, highlights: _highlights, ...rest } = minor;
    expect(releaseNotesFileSchema.safeParse(rest).success).toBe(true);
  });

  it('rejects a headline or highlights on a patch', () => {
    expect(releaseNotesFileSchema.safeParse({ ...minor, version: '2.3.1' }).success).toBe(false);
    const { headline: _headline, ...withHighlights } = minor;
    expect(releaseNotesFileSchema.safeParse({ ...withHighlights, version: '2.3.1' }).success).toBe(
      false
    );
  });

  it('rejects a prerelease version', () => {
    const { headline: _headline, highlights: _highlights, ...rest } = minor;
    expect(releaseNotesFileSchema.safeParse({ ...rest, version: '2.4.0-beta.1' }).success).toBe(
      false
    );
  });

  it('enforces the text limits', () => {
    const withText = (text: string) => ({ ...minor, changes: [{ type: 'fix', text }] });
    expect(releaseNotesFileSchema.safeParse(withText('a'.repeat(120))).success).toBe(true);
    expect(releaseNotesFileSchema.safeParse(withText('a'.repeat(121))).success).toBe(false);
    expect(releaseNotesFileSchema.safeParse(withText('ends with a period.')).success).toBe(false);
    expect(releaseNotesFileSchema.safeParse(withText('two\nlines')).success).toBe(false);
  });

  it('rejects unknown keys, bad refs and off-site docs', () => {
    expect(releaseNotesFileSchema.safeParse({ ...minor, extra: true }).success).toBe(false);
    expect(
      releaseNotesFileSchema.safeParse({
        ...minor,
        changes: [{ type: 'fix', text: 'x', refs: ['1171'] }],
      }).success
    ).toBe(false);
    expect(
      releaseNotesFileSchema.safeParse({
        ...minor,
        changes: [{ type: 'fix', text: 'x', docs: 'https://example.com/a' }],
      }).success
    ).toBe(false);
  });
});

describe('releaseTagIssues', () => {
  it('flags a missing headline and highlights when tagging the stable x.y.0', () => {
    const { headline: _headline, highlights: _highlights, ...rest } = minor;
    expect(releaseTagIssues(rest, 'v2.3.0')).toEqual([
      'tagging v2.3.0 needs a headline',
      'tagging v2.3.0 needs 1 to 4 highlights',
    ]);
  });

  it('is clean for a beta tag on the same in-progress file', () => {
    const { headline: _headline, highlights: _highlights, ...rest } = minor;
    expect(releaseTagIssues(rest, 'v2.3.0-beta.7')).toEqual([]);
  });

  it('flags a version mismatch', () => {
    expect(releaseTagIssues(minor, 'v2.4.0-beta.1')).toEqual([
      'release-notes/2.4.0.json says version 2.3.0',
    ]);
  });

  it('is clean for a complete file tagged stable', () => {
    expect(releaseTagIssues(minor, 'v2.3.0')).toEqual([]);
  });
});

describe('renderReleaseNotesMarkdown', () => {
  it('renders a minor release', () => {
    expect(renderReleaseNotesMarkdown(minor)).toBe(
      [
        '# Tracearr v2.3.0 - Seerr requests, newsletters, and email',
        '',
        '**Back up before upgrading**',
        '',
        '### Requests',
        'Link Seerr to a server and Tracearr mirrors its request history, read-only. [Docs](https://docs.tracearr.com/configuration/requests)',
        '',
        '### New',
        '- Request history on its own page ([docs](https://docs.tracearr.com/configuration/requests))',
        '',
        '### Fixes',
        '- Plex metadata refreshes no longer trigger a sync every 30 seconds (#1171)',
        '',
        '### Notes',
        '- Migrations 0097 to 0104, nothing destructive',
        '',
      ].join('\n')
    );
  });

  it('adds the minor footer to a stable patch and nothing to a beta', () => {
    const patch: ReleaseNotesFile = {
      version: '2.3.1',
      date: '2026-09-22',
      changes: [{ type: 'fix', text: 'a fix' }],
    };
    expect(renderReleaseNotesMarkdown(patch)).toBe(
      '# Tracearr v2.3.1\n\n### Fixes\n- A fix\n\nOther release notes: https://github.com/connorgallopo/Tracearr/releases/tag/v2.3.0\n'
    );
  });

  it('titles with the tag and drops the footer for a beta on either an x.y.0 or a patch file', () => {
    const { headline: _headline, highlights: _highlights, ...inProgress } = minor;
    expect(renderReleaseNotesMarkdown(inProgress, 'v2.3.0-beta.7')).toBe(
      [
        '# Tracearr v2.3.0-beta.7',
        '',
        '**Back up before upgrading**',
        '',
        '### New',
        '- Request history on its own page ([docs](https://docs.tracearr.com/configuration/requests))',
        '',
        '### Fixes',
        '- Plex metadata refreshes no longer trigger a sync every 30 seconds (#1171)',
        '',
        '### Notes',
        '- Migrations 0097 to 0104, nothing destructive',
        '',
      ].join('\n')
    );

    const patch: ReleaseNotesFile = {
      version: '2.3.1',
      date: '2026-09-22',
      changes: [{ type: 'fix', text: 'a fix' }],
    };
    expect(renderReleaseNotesMarkdown(patch, 'v2.3.1-beta.2')).toBe(
      '# Tracearr v2.3.1-beta.2\n\n### Fixes\n- A fix\n'
    );
    expect(renderReleaseNotesMarkdown(patch, 'v2.3.1')).toBe(
      '# Tracearr v2.3.1\n\n### Fixes\n- A fix\n\nOther release notes: https://github.com/connorgallopo/Tracearr/releases/tag/v2.3.0\n'
    );
  });
});
