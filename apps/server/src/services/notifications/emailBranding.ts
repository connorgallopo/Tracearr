import {
  DEFAULT_EMAIL_BRANDING,
  emailBrandingReadSchema,
  type EmailBrandingSettings,
} from '@tracearr/shared';
import type { EmailBranding } from '@tracearr/emails';
import { createLogger } from '../../utils/logger.js';
import { firstIssueMessage } from '../../utils/zod.js';
import { getSetting, setSetting } from '../settings.js';

const logger = createLogger('email-branding');

export interface ResolvedEmailBranding {
  /** The caller adds the sender name: per newsletter for digests, the event's server for alerts. */
  branding: Omit<EmailBranding, 'senderName'>;
  logo: EmailBrandingSettings['logo'];
  mailtoUnsubscribe: boolean;
}

/** Keys an older build wrote are dropped; a block that still fails the schema reads as the defaults. */
export async function getEmailBranding(): Promise<EmailBrandingSettings> {
  const stored = await getSetting('emailBranding');
  const parsed = emailBrandingReadSchema.safeParse(stored ?? {});
  if (parsed.success) return parsed.data;
  if (stored !== null) {
    logger.warn('Stored email branding failed validation; using defaults', {
      issue: firstIssueMessage(parsed.error),
    });
  }
  return DEFAULT_EMAIL_BRANDING;
}

export async function saveEmailBranding(
  input: EmailBrandingSettings
): Promise<EmailBrandingSettings> {
  await setSetting('emailBranding', input);
  return input;
}

export async function resolveEmailBranding(): Promise<ResolvedEmailBranding> {
  const stored = await getEmailBranding();
  return {
    branding: {
      accentColor: stored.accentColor,
      footerText: stored.footerText,
      postalAddress: stored.postalAddress,
    },
    logo: stored.logo,
    mailtoUnsubscribe: stored.mailtoUnsubscribe,
  };
}
