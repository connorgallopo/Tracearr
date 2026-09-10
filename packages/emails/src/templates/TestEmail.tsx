import { Text } from '@react-email/components';
import { Cell } from '../components/Cell.js';
import { Layout } from '../components/Layout.js';
import { card, heading, paragraph } from '../styles.js';
import type { EmailBranding, TestEmailInput } from '../types.js';

export function TestEmail({ input, branding }: { input: TestEmailInput; branding: EmailBranding }) {
  return (
    <Layout preview="Test email from Tracearr" branding={branding} logoRef={input.logoRef}>
      <Cell style={card}>
        <Text style={heading(branding.accentColor)}>Email destination works</Text>
        <Text style={paragraph}>
          This is a test message from the destination named {input.destinationName}. If you can read
          it, Tracearr can reach your mail server.
        </Text>
      </Cell>
    </Layout>
  );
}
