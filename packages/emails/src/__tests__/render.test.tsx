import { describe, expect, it } from 'vitest';
import { defaultBranding, renderEvent, renderTest } from '../index.js';

describe('renderTest', () => {
  it('renders the destination name into html and text with a language and presentation tables', async () => {
    const out = await renderTest(
      { destinationName: 'Ops inbox', logoRef: 'cid:logo' },
      defaultBranding('Basement Plex')
    );
    expect(out.subject).toBe('Test email from Tracearr (Ops inbox)');
    expect(out.html).toContain('lang="en"');
    expect(out.html).toContain('role="presentation"');
    expect(out.html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1"/>'
    );
    expect(out.html).toContain('<meta name="color-scheme" content="dark"/>');
    expect(out.html).toContain('<meta name="supported-color-schemes" content="dark"/>');
    expect(out.html).toContain('<body lang="en" dir="ltr"');
    expect(out.html).toContain('Ops inbox');
    expect(out.html).toContain('src="cid:logo"');
    expect(out.html).not.toContain('rel="preload"');
    expect(out.text).toContain('Ops inbox');
    expect(out.text).not.toContain('cid:');
  });

  it('omits the logo image when no ref is given', async () => {
    const out = await renderTest({ destinationName: 'x', logoRef: null }, defaultBranding('S'));
    expect(out.html).not.toContain('<img');
  });

  it('gives every emitted table cell an explicit background and text color', async () => {
    const branding = defaultBranding('S');
    const outs = await Promise.all([
      renderTest({ destinationName: 'x', logoRef: null }, branding),
      renderEvent(
        {
          subject: 'Added: Heat (1995)',
          title: 'Media added',
          message: 'Heat (1995) was added to Movies',
          severity: 'low',
          timestamp: '2026-09-02T12:00:00.000Z',
          card: {
            kind: 'media',
            headline: 'Heat',
            subtitle: 'Movies',
            year: 1995,
            qualityLines: ['4K HDR'],
            posterRef: 'cid:poster',
            links: [{ label: 'Open in Plex', url: 'https://app.plex.tv/x' }],
          },
          logoRef: 'cid:logo',
          appUrl: 'https://tracearr.example.com',
        },
        branding
      ),
      renderEvent(
        {
          subject: 'Concurrent streams',
          title: 'Concurrent streams',
          message: 'alice is streaming from 3 devices',
          severity: 'high',
          timestamp: '2026-09-02T12:00:00.000Z',
          card: {
            kind: 'facts',
            facts: [
              { label: 'User', value: 'alice' },
              { label: 'Rule', value: 'Max 2 streams' },
            ],
          },
          logoRef: null,
          appUrl: null,
        },
        branding
      ),
    ]);
    for (const out of outs) {
      expect(out.html).not.toMatch(/;margin:[^;"]*;margin-top:/);
      const cells = out.html.match(/<td[^>]*>/g) ?? [];
      expect(cells.length).toBeGreaterThan(0);
      for (const cell of cells) {
        expect(cell).toMatch(/background-color:/);
        expect(cell).toMatch(/(?<!-)color:/);
      }
    }
  });
});

const branding = defaultBranding('Basement Plex');

describe('renderEvent', () => {
  it('renders a media card with poster, quality lines and links', async () => {
    const out = await renderEvent(
      {
        subject: 'Added: Heat (1995)',
        title: 'Media added',
        message: 'Heat (1995) was added to Movies',
        severity: 'low',
        timestamp: '2026-09-02T12:00:00.000Z',
        card: {
          kind: 'media',
          headline: 'Heat',
          subtitle: 'Movies on Basement Plex',
          year: 1995,
          qualityLines: ['4K HDR', 'TrueHD 7.1'],
          posterRef: 'cid:poster',
          links: [{ label: 'Open in Plex', url: 'https://app.plex.tv/x' }],
        },
        logoRef: 'cid:logo',
        appUrl: 'https://tracearr.example.com',
      },
      branding
    );
    expect(out.subject).toBe('Added: Heat (1995)');
    expect(out.html).toContain('src="cid:poster"');
    expect(out.html).not.toContain('rel="preload"');
    expect(out.html).toContain('alt="Heat"');
    expect(out.html).toContain('4K HDR');
    expect(out.html).toContain('href="https://app.plex.tv/x"');
    expect(out.html).toContain('href="https://tracearr.example.com"');
    expect(out.html).toMatch(new RegExp(`color:\\s*${branding.accentColor}`));
    expect(out.text).toContain('Heat (1995) was added to Movies');
    expect(out.text).toContain('https://app.plex.tv/x');
    expect(out.text).not.toContain('cid:');
  });

  it('renders a facts card and a severity label without any image', async () => {
    const out = await renderEvent(
      {
        subject: 'Concurrent streams',
        title: 'Concurrent streams',
        message: 'alice is streaming from 3 devices',
        severity: 'high',
        timestamp: '2026-09-02T12:00:00.000Z',
        card: {
          kind: 'facts',
          facts: [
            { label: 'User', value: 'alice' },
            { label: 'Rule', value: 'Max 2 streams' },
          ],
        },
        logoRef: null,
        appUrl: null,
      },
      branding
    );
    expect(out.html).not.toContain('<img');
    expect(out.html).toContain('High');
    expect(out.html).toContain('Max 2 streams');
    expect(out.text).toMatch(/Rule:\s*Max 2 streams/);
  });

  it('escapes html in owner-provided text', async () => {
    const out = await renderEvent(
      {
        subject: 's',
        title: '<b>bold</b>',
        message: 'x',
        severity: 'low',
        timestamp: '2026-09-02T12:00:00.000Z',
        card: null,
        logoRef: null,
        appUrl: null,
      },
      branding
    );
    expect(out.html).toContain('&lt;b&gt;bold&lt;/b&gt;');
    expect(out.html).not.toContain('<b>bold</b>');
  });
});
