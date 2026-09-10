import { Body, Head, Html, Preview } from '@react-email/components';
import type { ReactNode } from 'react';
import { body, frame, framePadding } from '../styles.js';
import { Cell } from './Cell.js';

/** The message declares its own dark scheme; the two colour-scheme metas are what stop Apple Mail re-colouring it. */
export function Document({ preview, children }: { preview: string; children: ReactNode }) {
  return (
    <Html lang="en" dir="ltr">
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="dark" />
        <meta name="supported-color-schemes" content="dark" />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={body} lang="en" dir="ltr">
        <Cell tableStyle={frame} style={framePadding}>
          {children}
        </Cell>
      </Body>
    </Html>
  );
}
