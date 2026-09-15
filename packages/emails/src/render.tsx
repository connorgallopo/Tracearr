import { render } from '@react-email/components';
import type { ReactElement } from 'react';
import { DigestEmail } from './templates/DigestEmail.js';
import { EventEmail } from './templates/EventEmail.js';
import { TestEmail } from './templates/TestEmail.js';
import type {
  DigestInput,
  EmailBranding,
  EventEmailInput,
  RenderedEmail,
  TestEmailInput,
} from './types.js';

/** React 19 hoists a preload link into head for every img; mail clients ignore it, and the server substitutes only img tags, so it would leak poster: refs. */
const IMAGE_PRELOAD = /<link rel="preload" as="image" href="[^"]*"\/>/g;

async function renderBoth(element: ReactElement, subject: string): Promise<RenderedEmail> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { subject, html: html.replace(IMAGE_PRELOAD, ''), text };
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

export function renderDigest(input: DigestInput, branding: EmailBranding): Promise<RenderedEmail> {
  return renderBoth(<DigestEmail input={input} branding={branding} />, input.subject);
}
