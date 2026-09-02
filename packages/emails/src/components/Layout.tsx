import { Body, Head, Hr, Html, Img, Preview, Text } from '@react-email/components';
import type { ReactNode } from 'react';
import { body, colors, frame, framePadding, muted, paragraph } from '../styles.js';
import type { EmailBranding } from '../types.js';
import { Cell } from './Cell.js';

interface LayoutProps {
  preview: string;
  branding: EmailBranding;
  logoRef: string | null;
  children: ReactNode;
}

export function Layout({ preview, branding, logoRef, children }: LayoutProps) {
  return (
    <Html lang="en">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={body}>
        <Cell tableStyle={frame} style={framePadding}>
          <Cell style={{ paddingBottom: '16px' }}>
            {logoRef && (
              <Img
                src={logoRef}
                alt={branding.senderName}
                width="40"
                height="40"
                style={{ display: 'inline-block', verticalAlign: 'middle', marginRight: '12px' }}
              />
            )}
            <Text
              style={{
                ...paragraph,
                display: 'inline-block',
                verticalAlign: 'middle',
                fontWeight: 600,
                margin: 0,
              }}
            >
              {branding.senderName}
            </Text>
          </Cell>
          {children}
          <Hr style={{ borderColor: colors.border, margin: '24px 0 12px' }} />
          <Cell style={{ paddingTop: '16px' }}>
            {branding.footerText && <Text style={muted}>{branding.footerText}</Text>}
            {branding.postalAddress && <Text style={muted}>{branding.postalAddress}</Text>}
            <Text style={muted}>Sent by Tracearr for {branding.senderName}.</Text>
          </Cell>
        </Cell>
      </Body>
    </Html>
  );
}
