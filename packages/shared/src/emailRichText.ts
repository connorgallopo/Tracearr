import { z } from 'zod';

export const EMAIL_RICH_TEXT_MAX_CHARS = 2000;
export const EMAIL_RICH_TEXT_MAX_BLOCKS = 50;
export const EMAIL_RICH_TEXT_MAX_LIST_ITEMS = 50;
export const EMAIL_RICH_TEXT_MAX_MARKS = 3;
/** Estimated rendered bytes per field. The clip budget is enforced at render time (apps/server/src/services/newsletters/fit.ts); this cap keeps one field from spending the whole digest. */
export const EMAIL_RICH_TEXT_MAX_WEIGHT = 3500;

/** Rendered bytes each node costs in packages/emails, measured against @react-email/components 1.0.12 on 2026-09-04. */
const WEIGHT = {
  paragraph: 138,
  bulletList: 60,
  listItem: 9,
  hardBreak: 5,
  bold: 17,
  italic: 9,
  link: 105,
} as const;

const MAILTO_ADDRESS = /^mailto:[^\s@/?#]+@[^\s@/?#]+$/i;

/** z.url() strips embedded CR/LF before it parses, so control characters are refused first; a mailto must carry an address. */
export const emailRichTextHrefSchema = z
  .string()
  .max(500)
  // eslint-disable-next-line no-control-regex -- matching control characters is the point of this check
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'Link must not contain control characters',
  })
  .pipe(z.url({ protocol: /^(https|mailto)$/ }))
  .refine((value) => !/^mailto:/i.test(value) || MAILTO_ADDRESS.test(value), {
    message: 'A mailto link needs an address',
  });

const markSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('bold') }),
  z.strictObject({ type: z.literal('italic') }),
  z.strictObject({
    type: z.literal('link'),
    attrs: z.strictObject({ href: emailRichTextHrefSchema }),
  }),
]);
export type EmailRichTextMark = z.infer<typeof markSchema>;

const textSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().min(1),
  marks: z
    .array(markSchema)
    .max(EMAIL_RICH_TEXT_MAX_MARKS)
    .refine((marks) => new Set(marks.map((mark) => mark.type)).size === marks.length, {
      message: 'A mark may appear once per text run',
    })
    .optional(),
});
const hardBreakSchema = z.strictObject({ type: z.literal('hardBreak') });
const inlineSchema = z.discriminatedUnion('type', [textSchema, hardBreakSchema]);
export type EmailRichTextInline = z.infer<typeof inlineSchema>;

const paragraphSchema = z.strictObject({
  type: z.literal('paragraph'),
  content: z.array(inlineSchema).optional(),
});
export type EmailRichTextParagraph = z.infer<typeof paragraphSchema>;

const listItemSchema = z.strictObject({
  type: z.literal('listItem'),
  content: z.array(paragraphSchema).min(1),
});
const bulletListSchema = z.strictObject({
  type: z.literal('bulletList'),
  content: z.array(listItemSchema).min(1).max(EMAIL_RICH_TEXT_MAX_LIST_ITEMS),
});
const blockSchema = z.discriminatedUnion('type', [paragraphSchema, bulletListSchema]);
export type EmailRichTextBlock = z.infer<typeof blockSchema>;

const docShape = z.strictObject({
  type: z.literal('doc'),
  content: z.array(blockSchema).max(EMAIL_RICH_TEXT_MAX_BLOCKS),
});
export type EmailRichTextDoc = z.infer<typeof docShape>;

function paragraphLength(paragraph: EmailRichTextParagraph): number {
  let total = 0;
  for (const node of paragraph.content ?? []) if (node.type === 'text') total += node.text.length;
  return total;
}

export function emailRichTextLength(doc: EmailRichTextDoc): number {
  let total = 0;
  for (const block of doc.content) {
    if (block.type === 'paragraph') {
      total += paragraphLength(block);
      continue;
    }
    for (const item of block.content) for (const p of item.content) total += paragraphLength(p);
  }
  return total;
}

const bytes = (value: string): number => new TextEncoder().encode(value).length;

function inlineWeight(node: EmailRichTextInline): number {
  if (node.type === 'hardBreak') return WEIGHT.hardBreak;
  let weight = bytes(node.text);
  for (const mark of node.marks ?? []) {
    weight += mark.type === 'link' ? WEIGHT.link + bytes(mark.attrs.href) : WEIGHT[mark.type];
  }
  return weight;
}

function paragraphWeight(paragraph: EmailRichTextParagraph): number {
  let weight = WEIGHT.paragraph;
  for (const node of paragraph.content ?? []) weight += inlineWeight(node);
  return weight;
}

export function emailRichTextWeight(doc: EmailRichTextDoc): number {
  let total = 0;
  for (const block of doc.content) {
    if (block.type === 'paragraph') {
      total += paragraphWeight(block);
      continue;
    }
    total += WEIGHT.bulletList;
    for (const item of block.content) {
      total += WEIGHT.listItem;
      for (const p of item.content) total += paragraphWeight(p);
    }
  }
  return total;
}

export const emailRichTextDocSchema = docShape
  .refine((doc) => emailRichTextLength(doc) <= EMAIL_RICH_TEXT_MAX_CHARS, {
    message: `Text must be at most ${EMAIL_RICH_TEXT_MAX_CHARS} characters`,
  })
  .refine((doc) => emailRichTextWeight(doc) <= EMAIL_RICH_TEXT_MAX_WEIGHT, {
    message: 'Too much formatting for the email size budget; shorten the text or remove some links',
  });

export function normalizeEmailRichText(
  doc: EmailRichTextDoc | null | undefined
): EmailRichTextDoc | null {
  if (!doc || emailRichTextLength(doc) === 0) return null;
  return doc;
}
