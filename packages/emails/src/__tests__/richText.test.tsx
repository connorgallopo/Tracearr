import { render } from '@react-email/components';
import { describe, expect, it } from 'vitest';
import { RichText } from '../components/RichText.js';
import type { RichTextDoc, RichTextInline } from '../types.js';

const ACCENT = '#0ea0b3';
const P_OPEN =
  '<p style="font-size:14px;line-height:24px;color:#e6e8eb;margin-top:0;margin-bottom:12px">';
const LI_P_OPEN =
  '<p style="font-size:14px;line-height:24px;color:#e6e8eb;margin-top:0;margin-bottom:0">';
const UL_OPEN = '<ul style="margin:0 0 12px;padding-left:20px;color:#e6e8eb">';
const A_OPEN = (href: string) =>
  `<a href="${href}" style="color:#0ea0b3;text-decoration-line:none;text-decoration:underline" target="_blank">`;

const strip = (html: string) =>
  html.replace(/^<!DOCTYPE[^>]*>/, '').replace(/<!--\$-->|<!--\/\$-->/g, '');
const html = async (doc: RichTextDoc) =>
  strip(await render(<RichText doc={doc} accent={ACCENT} />));
const text = async (doc: RichTextDoc) =>
  render(<RichText doc={doc} accent={ACCENT} />, { plainText: true });

const paragraph = (...content: RichTextInline[]): RichTextDoc => ({
  type: 'doc',
  content: [{ type: 'paragraph', content }],
});

describe('RichText', () => {
  it('renders a paragraph with the digest paragraph style', async () => {
    expect(await html(paragraph({ type: 'text', text: 'Hello' }))).toBe(`${P_OPEN}Hello</p>`);
  });

  it('renders bold and italic as strong and em', async () => {
    expect(
      await html(
        paragraph(
          { type: 'text', text: 'b', marks: [{ type: 'bold' }] },
          { type: 'text', text: ' ' },
          { type: 'text', text: 'i', marks: [{ type: 'italic' }] }
        )
      )
    ).toBe(`${P_OPEN}<strong>b</strong> <em>i</em></p>`);
  });

  it('renders an https link with the digest link style', async () => {
    expect(
      await html(
        paragraph({
          type: 'text',
          text: 'site',
          marks: [{ type: 'link', attrs: { href: 'https://example.com/x' } }],
        })
      )
    ).toBe(`${P_OPEN}${A_OPEN('https://example.com/x')}site</a></p>`);
  });

  it('renders a mailto link', async () => {
    expect(
      await html(
        paragraph({
          type: 'text',
          text: 'mail',
          marks: [{ type: 'link', attrs: { href: 'mailto:a@b.com' } }],
        })
      )
    ).toBe(`${P_OPEN}${A_OPEN('mailto:a@b.com')}mail</a></p>`);
  });

  it('renders a hard break as br and a newline in text', async () => {
    const doc = paragraph(
      { type: 'text', text: 'A' },
      { type: 'hardBreak' },
      { type: 'text', text: 'B' }
    );
    expect(await html(doc)).toBe(`${P_OPEN}A<br/>B</p>`);
    expect(await text(doc)).toBe('A\nB');
  });

  it('nests three marks with the link outermost', async () => {
    expect(
      await html(
        paragraph({
          type: 'text',
          text: 'x',
          marks: [
            { type: 'bold' },
            { type: 'italic' },
            { type: 'link', attrs: { href: 'https://a.b/' } },
          ],
        })
      )
    ).toBe(`${P_OPEN}${A_OPEN('https://a.b/')}<em><strong>x</strong></em></a></p>`);
  });

  it('renders a bullet list with each item paragraph unmargined', async () => {
    const doc: RichTextDoc = {
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'One' }] }],
            },
            {
              type: 'listItem',
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Two' }] }],
            },
          ],
        },
      ],
    };
    expect(await html(doc)).toBe(
      `${UL_OPEN}<li>${LI_P_OPEN}One</p></li><li>${LI_P_OPEN}Two</p></li></ul>`
    );
    expect(await text(doc)).toBe(' * One\n\n * Two');
  });

  it('renders an empty paragraph and an empty document', async () => {
    expect(await html({ type: 'doc', content: [{ type: 'paragraph' }] })).toBe(`${P_OPEN}</p>`);
    expect(await html({ type: 'doc', content: [] })).toBe('');
  });

  it('escapes text and never emits an anchor for a scheme outside https and mailto', async () => {
    const out = await html(
      paragraph({
        type: 'text',
        text: '<script>x</script>',
        marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }],
      })
    );
    expect(out).toBe(`${P_OPEN}&lt;script&gt;x&lt;/script&gt;</p>`);
    expect(out).not.toContain('<a ');
  });
});
