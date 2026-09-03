import {
  DEFAULT_EMAIL_BRANDING,
  emailBrandingSchema,
  type EmailBrandingSettings,
} from '@tracearr/shared';
import type { EmailBranding } from '@tracearr/emails';
import { createLogger } from '../../utils/logger.js';
import { firstIssueMessage } from '../../utils/zod.js';
import { getSetting, setSetting } from '../settings.js';

const logger = createLogger('email-branding');

export interface ResolvedEmailBranding {
  branding: EmailBranding;
  logo: EmailBrandingSettings['logo'];
  mailtoUnsubscribe: boolean;
}

/** A block written by another build still reads as a full block; one that fails the schema reads as the defaults. */
export async function getEmailBranding(): Promise<EmailBrandingSettings> {
  const stored = await getSetting('emailBranding');
  const parsed = emailBrandingSchema.safeParse(stored ?? {});
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

/** The block every email renders with; the sender name falls back to the name the caller knows. */
export async function resolveEmailBranding(
  fallbackSenderName: string
): Promise<ResolvedEmailBranding> {
  const stored = await getEmailBranding();
  return {
    branding: {
      senderName: stored.senderName ?? fallbackSenderName,
      accentColor: stored.accentColor,
      footerText: stored.footerText,
      postalAddress: stored.postalAddress,
    },
    logo: stored.logo,
    mailtoUnsubscribe: stored.mailtoUnsubscribe,
  };
}
