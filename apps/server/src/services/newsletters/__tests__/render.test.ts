import { describe, expect, it } from 'vitest';
import { formatWindowDate, resolveImageMode, substitutePosterRefs } from '../render.js';

const posters = {
  m1: {
    serverId: '11111111-1111-4111-8111-111111111111',
    thumbPath: '/library/metadata/1/thumb',
    version: 'abcdef12',
  },
};
const html = '<p>x</p><img src="poster:m1" alt="Heat" width="80"><img src="cid:logo" alt="logo">';

describe('substitutePosterRefs', () => {
  it('hosted mode points at the external url with the versioned proxy path', () => {
    const out = substitutePosterRefs(html, posters, 'hosted', 'https://tracearr.example.com/');
    expect(out).toContain(
      'src="https://tracearr.example.com/api/v1/images/proxy?server=11111111-1111-4111-8111-111111111111&url=%2Flibrary%2Fmetadata%2F1%2Fthumb&width=360&height=540&fallback=poster&v=abcdef12"'
    );
    expect(out).toContain('src="cid:logo"');
  });
  it('inline mode rewrites to a cid and leaves unknown refs as no image', () => {
    const out = substitutePosterRefs(
      `${html}<img src="poster:unknown" alt="x">`,
      posters,
      'inline',
      null
    );
    expect(out).toContain('src="cid:m1"');
    expect(out).not.toContain('poster:unknown');
    expect(out).not.toContain('alt="x"');
  });
  it('none mode removes poster images and keeps the logo', () => {
    const out = substitutePosterRefs(html, posters, 'none', null);
    expect(out).not.toContain('<img src="poster:');
    expect(out).not.toContain('alt="Heat"');
    expect(out).toContain('src="cid:logo"');
  });
});

describe('resolveImageMode', () => {
  it('auto and hosted-without-url resolve to inline; hosted needs a url; none stays none', () => {
    expect(resolveImageMode('auto', 'https://x')).toBe('inline');
    expect(resolveImageMode('auto', null)).toBe('inline');
    expect(resolveImageMode('hosted', null)).toBe('inline');
    expect(resolveImageMode('hosted', 'https://x')).toBe('hosted');
    expect(resolveImageMode('inline', 'https://x')).toBe('inline');
    expect(resolveImageMode('none', 'https://x')).toBe('none');
  });
});

describe('formatWindowDate', () => {
  it('renders in the newsletter timezone', () => {
    expect(formatWindowDate(new Date('2026-09-02T03:00:00.000Z'), 'America/Los_Angeles')).toBe(
      'Sep 1, 2026'
    );
    expect(formatWindowDate(new Date('2026-09-02T03:00:00.000Z'), 'UTC')).toBe('Sep 2, 2026');
  });
});
