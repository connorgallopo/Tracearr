import { describe, it, expect } from 'vitest';
import { fromTiptapJson, parseRichText, textLengthOf } from './rich-text-normalize';

const tiptapDoc = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        {
          type: 'text',
          text: 'Discord',
          marks: [
            {
              type: 'link',
              attrs: {
                href: 'https://discord.gg/x',
                target: '_blank',
                rel: 'noopener noreferrer nofollow',
                class: null,
              },
            },
            { type: 'bold' },
          ],
        },
      ],
    },
  ],
};

describe('fromTiptapJson', () => {
  it('keeps a link mark down to its href and touches nothing else', () => {
    expect(fromTiptapJson(tiptapDoc)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Discord',
              marks: [{ type: 'link', attrs: { href: 'https://discord.gg/x' } }, { type: 'bold' }],
            },
          ],
        },
      ],
    });
  });

  it('leaves an unknown node in place so the grammar rejects it', () => {
    const doc = { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [] }] };
    expect(fromTiptapJson(doc)).toEqual(doc);
  });
});

describe('parseRichText', () => {
  it('turns the empty editor document into null with no error', () => {
    expect(parseRichText({ type: 'doc', content: [{ type: 'paragraph' }] })).toEqual({
      value: null,
      error: null,
      length: 0,
    });
  });

  it('returns the normalized document and its length when valid', () => {
    const out = parseRichText(tiptapDoc);
    expect(out.error).toBeNull();
    expect(out.length).toBe(7);
    expect(out.value?.content[0]).toMatchObject({ type: 'paragraph' });
  });

  it('reports the first issue and still counts the text when invalid', () => {
    const out = parseRichText({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'x'.repeat(2001) }] }],
    });
    expect(out).toEqual({
      value: null,
      error: 'Text must be at most 2000 characters',
      length: 2001,
    });
    expect(textLengthOf(undefined)).toBe(0);
  });
});
