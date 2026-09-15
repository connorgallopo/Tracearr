import {
  emailRichTextDocSchema,
  emailRichTextLength,
  normalizeEmailRichText,
  type EmailRichTextDoc,
} from '@tracearr/shared';

export interface RichTextChange {
  /** The last valid document, null when the field is empty or invalid. */
  value: EmailRichTextDoc | null;
  error: string | null;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null;

/** Tiptap emits target, rel and class on every link mark; the grammar admits only href. */
export function fromTiptapJson(json: unknown): unknown {
  if (Array.isArray(json)) return json.map(fromTiptapJson);
  if (!isObject(json)) return json;
  if (json['type'] === 'link' && isObject(json['attrs'])) {
    return { type: 'link', attrs: { href: json['attrs']['href'] } };
  }
  const out: Json = {};
  for (const [key, value] of Object.entries(json)) out[key] = fromTiptapJson(value);
  return out;
}

export function textLengthOf(json: unknown): number {
  if (Array.isArray(json)) return json.reduce<number>((n, node) => n + textLengthOf(node), 0);
  if (!isObject(json)) return 0;
  if (json['type'] === 'text' && typeof json['text'] === 'string') return json['text'].length;
  return textLengthOf(json['content']);
}

export function parseRichText(json: unknown): RichTextChange & { length: number } {
  const candidate = fromTiptapJson(json);
  const parsed = emailRichTextDocSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      value: null,
      error: parsed.error.issues[0]?.message ?? 'Invalid content',
      length: textLengthOf(candidate),
    };
  }
  return {
    value: normalizeEmailRichText(parsed.data),
    error: null,
    length: emailRichTextLength(parsed.data),
  };
}
