import { describe, it, expect, vi } from 'vitest';

vi.mock('../../imageProxy.js', () => ({
  buildProxyUrl: (o: { serverId: string; path: string; version?: string }) =>
    `/api/v1/images/proxy?server=${o.serverId}&url=${encodeURIComponent(o.path)}&v=${o.version ?? ''}`,
}));

import { digestForBrowser } from '../snapshot.js';

const html = [
  '<img src="cid:logo" alt="Movies">',
  '<p style="a">Hi</p>',
  '<img src="poster:m1" alt="Heat">',
  '<img src="poster:gone" alt="Missing">',
  '<p style="m"><a href="{{view_url}}" style="l" target="_blank">View in browser</a></p>',
  '<p style="m"><a href="{{unsubscribe_url}}" style="l" target="_blank">Unsubscribe</a></p>',
  '<p style="m">Sent by Tracearr for Movies.</p>',
].join('');
const posters = { m1: { serverId: 's1', thumbPath: '/t/1', version: 'v1' } };

describe('digestForBrowser', () => {
  it('rewrites posters and the logo to relative urls and neutralizes both footer lines', () => {
    const out = digestForBrowser(html, posters);
    expect(out).toContain('src="/api/v1/images/logo"');
    expect(out).toContain('src="/api/v1/images/proxy?server=s1&url=%2Ft%2F1&v=v1"');
    expect(out).not.toContain('poster:');
    expect(out).not.toContain('cid:');
    expect(out).not.toContain('View in browser');
    expect(out).not.toContain('{{view_url}}');
    expect(out).not.toContain('{{unsubscribe_url}}');
    expect(out).not.toContain('href="{{');
    expect(out).toContain('Unsubscribe links are only in the email itself.');
    expect(out).toContain('<p style="m">Sent by Tracearr for Movies.</p>');
    expect(out).toContain('<p style="a">Hi</p>');
  });

  it('leaves a snapshot without placeholders alone apart from the image rewrites', () => {
    const plain = '<p>Hi</p><p>Reply to this email to unsubscribe.</p>';
    expect(digestForBrowser(plain, {})).toBe(plain);
  });
});
