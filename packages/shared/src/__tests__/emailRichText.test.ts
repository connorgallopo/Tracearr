import { describe, expect, it } from 'vitest';
import {
  EMAIL_RICH_TEXT_MAX_CHARS,
  EMAIL_RICH_TEXT_MAX_WEIGHT,
  emailRichTextDocSchema,
  emailRichTextHrefSchema,
  emailRichTextLength,
  emailRichTextWeight,
  normalizeEmailRichText,
  type EmailRichTextDoc,
  type EmailRichTextInline,
  type EmailRichTextMark,
  type EmailRichTextParagraph,
} from '../index.js';

const text = (value: string): EmailRichTextInline[] => [{ type: 'text', text: value }];
const paragraph = (content: EmailRichTextInline[]): EmailRichTextParagraph => ({
  type: 'paragraph',
  content,
});
const doc = (...content: EmailRichTextDoc['content']): EmailRichTextDoc => ({
  type: 'doc',
  content,
});
const LINK = { type: 'link', attrs: { href: 'https://example.com/x' } } as const;
const LONG_HREF = `https://example.com/${'x'.repeat(20)}`;

/** The two heaviest documents the grammar admits; packages/emails renders the same two in its size gate. */
const heaviestList = (items: number): EmailRichTextDoc => ({
  type: 'doc',
  content: [
    {
      type: 'bulletList',
      content: Array.from({ length: items }, () => ({
        type: 'listItem' as const,
        content: [
          {
            type: 'paragraph' as const,
            content: [
              {
                type: 'text' as const,
                text: 'x'.repeat(100),
                marks: [
                  { type: 'bold' as const },
                  { type: 'link' as const, attrs: { href: LONG_HREF } },
                ],
              },
            ],
          },
        ],
      })),
    },
  ],
});
const heaviestRuns = (runs: number): EmailRichTextDoc => ({
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: Array.from({ length: runs }, () => ({
        type: 'text' as const,
        text: 'x',
        marks: [
          { type: 'bold' as const },
          { type: 'italic' as const },
          { type: 'link' as const, attrs: { href: LONG_HREF } },
        ],
      })),
    },
  ],
});

describe('emailRichTextDocSchema accepts', () => {
  it.each<[string, EmailRichTextDoc]>([
    ['an empty document', doc()],
    ['a paragraph', doc(paragraph(text('Hello')))],
    ['bold', doc(paragraph([{ type: 'text', text: 'b', marks: [{ type: 'bold' }] }]))],
    ['italic', doc(paragraph([{ type: 'text', text: 'i', marks: [{ type: 'italic' }] }]))],
    ['an https link', doc(paragraph([{ type: 'text', text: 'l', marks: [LINK] }]))],
    [
      'a mailto link',
      doc(
        paragraph([
          { type: 'text', text: 'm', marks: [{ type: 'link', attrs: { href: 'mailto:a@b.com' } }] },
        ])
      ),
    ],
    [
      'a hard break',
      doc(
        paragraph([{ type: 'text', text: 'a' }, { type: 'hardBreak' }, { type: 'text', text: 'b' }])
      ),
    ],
    [
      'a bullet list',
      doc({
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [paragraph(text('one'))] },
          { type: 'listItem', content: [paragraph(text('two'))] },
        ],
      }),
    ],
    [
      'three distinct marks on one run',
      doc(
        paragraph([
          { type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'italic' }, LINK] },
        ])
      ),
    ],
  ])('%s', (_label, value) => {
    const parsed = emailRichTextDocSchema.safeParse(value);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toEqual(value);
  });
});

describe('emailRichTextDocSchema rejects', () => {
  const firstIssue = (value: unknown) => {
    const parsed = emailRichTextDocSchema.safeParse(value);
    if (parsed.success) throw new Error('expected a rejection');
    const issue = parsed.error.issues[0];
    if (!issue) throw new Error('expected an issue');
    return issue;
  };
  const linked = (href: string) =>
    doc(paragraph([{ type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href } }] }]));

  it('a javascript href', () => {
    const issue = firstIssue(linked('javascript:alert(1)'));
    expect(issue.message).toBe('Invalid URL');
    expect(issue.path).toEqual(['content', 0, 'content', 0, 'marks', 0, 'attrs', 'href']);
  });

  it('a data href', () => {
    expect(firstIssue(linked('data:text/html,x')).message).toBe('Invalid URL');
  });

  it('a mailto without an address, an http link, and a control character', () => {
    expect(emailRichTextHrefSchema.safeParse('mailto:').success).toBe(false);
    expect(emailRichTextHrefSchema.safeParse('http://example.com').success).toBe(false);
    expect(emailRichTextHrefSchema.safeParse('https://example.com/a\r\nx').success).toBe(false);
  });

  it('a nested list', () => {
    const issue = firstIssue({
      type: 'doc',
      content: [
        {
          type: 'bulletList',
          content: [{ type: 'listItem', content: [{ type: 'bulletList', content: [] }] }],
        },
      ],
    });
    expect(issue.path).toEqual(['content', 0, 'content', 0, 'content', 0, 'type']);
    expect(issue.message).toMatch(/expected "paragraph"/);
  });

  it('an unknown node', () => {
    const issue = firstIssue({ type: 'doc', content: [{ type: 'heading', content: [] }] });
    expect(issue.path).toEqual(['content', 0, 'type']);
  });

  it('an unknown attribute', () => {
    const issue = firstIssue({
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { textAlign: 'center' } }],
    });
    expect(issue.message).toBe('Unrecognized key: "attrs"');
  });

  it('a link mark carrying target', () => {
    const issue = firstIssue(
      doc(
        paragraph([
          {
            type: 'text',
            text: 'x',
            marks: [
              {
                type: 'link',
                attrs: { href: 'https://a.b', target: '_blank' },
              } as EmailRichTextMark,
            ],
          },
        ])
      )
    );
    expect(issue.message).toBe('Unrecognized key: "target"');
  });

  it('over-budget text', () => {
    const issue = firstIssue(doc(paragraph(text('x'.repeat(EMAIL_RICH_TEXT_MAX_CHARS + 1)))));
    expect(issue.message).toBe(`Text must be at most ${EMAIL_RICH_TEXT_MAX_CHARS} characters`);
  });

  it('too many marks and a repeated mark', () => {
    const four = doc(
      paragraph([
        {
          type: 'text',
          text: 'x',
          marks: [{ type: 'bold' }, { type: 'italic' }, LINK, { type: 'bold' }],
        },
      ])
    );
    expect(firstIssue(four).message).toMatch(/Too big/);
    const twice = doc(
      paragraph([{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'bold' }] }])
    );
    expect(firstIssue(twice).message).toBe('A mark may appear once per text run');
  });

  it('an empty text run', () => {
    expect(firstIssue(doc(paragraph([{ type: 'text', text: '' }]))).path).toEqual([
      'content',
      0,
      'content',
      0,
      'text',
    ]);
  });

  it('formatting past the weight budget', () => {
    expect(firstIssue(heaviestList(9)).message).toBe(
      'Too much formatting for the email size budget; shorten the text or remove some links'
    );
    expect(emailRichTextDocSchema.safeParse(heaviestRuns(20)).success).toBe(false);
  });
});

describe('measures', () => {
  it('counts characters across paragraphs and list items', () => {
    const value = doc(paragraph(text('abc')), {
      type: 'bulletList',
      content: [{ type: 'listItem', content: [paragraph(text('de'))] }],
    });
    expect(emailRichTextLength(value)).toBe(5);
    expect(emailRichTextLength(doc(paragraph([{ type: 'hardBreak' }])))).toBe(0);
  });

  it('weighs a plain 2000-character paragraph at its measured rendered size', () => {
    expect(emailRichTextWeight(doc(paragraph(text('x'.repeat(2000)))))).toBe(2138);
    expect(emailRichTextWeight(doc())).toBe(0);
  });

  it('admits both gate fixtures under the weight cap', () => {
    expect(EMAIL_RICH_TEXT_MAX_WEIGHT).toBe(3500);
    expect(emailRichTextWeight(heaviestList(8))).toBe(3332);
    expect(emailRichTextWeight(heaviestRuns(19))).toBe(3406);
    expect(emailRichTextDocSchema.safeParse(heaviestList(8)).success).toBe(true);
    expect(emailRichTextDocSchema.safeParse(heaviestRuns(19)).success).toBe(true);
  });

  it('normalizes a document with no text to null and leaves others alone', () => {
    expect(normalizeEmailRichText(doc())).toBeNull();
    expect(normalizeEmailRichText(doc({ type: 'paragraph' }))).toBeNull();
    expect(normalizeEmailRichText(null)).toBeNull();
    const value = doc(paragraph(text('hi')));
    expect(normalizeEmailRichText(value)).toBe(value);
  });
});
