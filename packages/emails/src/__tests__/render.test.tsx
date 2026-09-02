import { describe, expect, it } from 'vitest';
import { defaultBranding, renderTest } from '../index.js';

describe('renderTest', () => {
  it('renders the destination name into html and text with a language and presentation tables', async () => {
    const out = await renderTest(
      { destinationName: 'Ops inbox', logoRef: 'cid:logo' },
      defaultBranding('Basement Plex')
    );
    expect(out.subject).toBe('Test email from Tracearr (Ops inbox)');
    expect(out.html).toContain('lang="en"');
    expect(out.html).toContain('role="presentation"');
    expect(out.html).toContain('Ops inbox');
    expect(out.html).toContain('src="cid:logo"');
    expect(out.text).toContain('Ops inbox');
    expect(out.text).not.toContain('cid:');
  });

  it('omits the logo image when no ref is given', async () => {
    const out = await renderTest({ destinationName: 'x', logoRef: null }, defaultBranding('S'));
    expect(out.html).not.toContain('<img');
  });

  it('gives every emitted table cell an explicit background and text color', async () => {
    const out = await renderTest({ destinationName: 'x', logoRef: null }, defaultBranding('S'));
    const cells = out.html.match(/<td[^>]*>/g) ?? [];
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(cell).toMatch(/background-color:/);
      expect(cell).toMatch(/(?<!-)color:/);
    }
  });
});
