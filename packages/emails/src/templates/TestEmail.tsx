import { Body, Head, Html, Img, Preview, Text } from '@react-email/components';
import { Cell } from '../components/Cell.js';
import { body, card, frame, framePadding, heading, muted, paragraph } from '../styles.js';
import type { EmailBranding, TestEmailInput } from '../types.js';

export function TestEmail({ input, branding }: { input: TestEmailInput; branding: EmailBranding }) {
  return (
    <Html lang="en">
      <Head />
      <Preview>Test email from Tracearr</Preview>
      <Body style={body}>
        <Cell tableStyle={frame} style={framePadding}>
          <Cell style={{ paddingBottom: '16px' }}>
            {input.logoRef && (
              <Img
                src={input.logoRef}
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
          <Cell style={card}>
            <Text style={heading(branding.accentColor)}>Email destination works</Text>
            <Text style={paragraph}>
              This is a test message from the destination named {input.destinationName}. If you can
              read it, Tracearr can reach your mail server.
            </Text>
          </Cell>
          <Cell style={{ paddingTop: '16px' }}>
            <Text style={muted}>Sent by Tracearr for {branding.senderName}.</Text>
          </Cell>
        </Cell>
      </Body>
    </Html>
  );
}
