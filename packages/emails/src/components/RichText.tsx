import { Link, Text } from '@react-email/components';
import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { colors, link, paragraph } from '../styles.js';
import type { RichTextDoc, RichTextInline, RichTextParagraph } from '../types.js';

const listStyle: CSSProperties = { margin: '0 0 12px', paddingLeft: '20px', color: colors.text };
const itemParagraph: CSSProperties = { ...paragraph, marginTop: 0, marginBottom: 0 };

/** The grammar admits https and mailto only; a stored href outside that renders as plain text rather than an anchor. */
const SAFE_HREF = /^(https:|mailto:)/i;

function inline(node: RichTextInline, key: number, accent: string): ReactNode {
  if (node.type === 'hardBreak') return <br key={key} />;
  let out: ReactNode = node.text;
  for (const mark of node.marks ?? []) {
    if (mark.type === 'bold') out = <strong>{out}</strong>;
    else if (mark.type === 'italic') out = <em>{out}</em>;
    else if (SAFE_HREF.test(mark.attrs.href)) {
      out = (
        <Link href={mark.attrs.href} style={link(accent)}>
          {out}
        </Link>
      );
    }
  }
  return <Fragment key={key}>{out}</Fragment>;
}

function Paragraph({
  node,
  accent,
  style,
}: {
  node: RichTextParagraph;
  accent: string;
  style: CSSProperties;
}) {
  return <Text style={style}>{(node.content ?? []).map((n, i) => inline(n, i, accent))}</Text>;
}

export function RichText({ doc, accent }: { doc: RichTextDoc; accent: string }) {
  return (
    <>
      {doc.content.map((block, i) =>
        block.type === 'paragraph' ? (
          <Paragraph key={i} node={block} accent={accent} style={paragraph} />
        ) : (
          <ul key={i} style={listStyle}>
            {block.content.map((item, j) => (
              <li key={j}>
                {item.content.map((p, k) => (
                  <Paragraph key={k} node={p} accent={accent} style={itemParagraph} />
                ))}
              </li>
            ))}
          </ul>
        )
      )}
    </>
  );
}
