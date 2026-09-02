import { render } from '@react-email/components';
import type { ReactElement } from 'react';
import { EventEmail } from './templates/EventEmail.js';
import { TestEmail } from './templates/TestEmail.js';
import type { EmailBranding, EventEmailInput, RenderedEmail, TestEmailInput } from './types.js';

async function renderBoth(element: ReactElement, subject: string): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject, html, text };
}

export function renderTest(input: TestEmailInput, branding: EmailBranding): Promise<RenderedEmail> {
  return renderBoth(
    <TestEmail input={input} branding={branding} />,
    `Test email from Tracearr (${input.destinationName})`
  );
}

export function renderEvent(
  input: EventEmailInput,
  branding: EmailBranding
): Promise<RenderedEmail> {
  return renderBoth(<EventEmail input={input} branding={branding} />, input.subject);
}
