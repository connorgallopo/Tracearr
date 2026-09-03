import { z } from 'zod';
import { paginationSchema, timezoneSchema, uuidSchema } from './schemas.js';

/** 12 is the largest cap at which the heaviest digest the assembler can emit stays clear of Gmail's 102 KB clip, proven by the size gate in packages/emails. */
export const NEWSLETTER_SECTION_MAX = 12;
export const NEWSLETTER_MOST_WATCHED_MAX = 10;
export const NEWSLETTER_SEASONS_PER_SHOW_MAX = 8;
export const NEWSLETTER_WINDOW_MAX_DAYS = 31;
export const NEWSLETTER_EXTRA_ADDRESSES_MAX = 200;

export const NEWSLETTER_SEND_TRIGGERS = ['schedule', 'manual', 'test'] as const;
export type NewsletterSendTrigger = (typeof NEWSLETTER_SEND_TRIGGERS)[number];

export const NEWSLETTER_SEND_OUTCOMES = [
  'rendering',
  'sending',
  'sent',
  'partial',
  'failed',
  'skipped_empty',
] as const;
export type NewsletterSendOutcome = (typeof NEWSLETTER_SEND_OUTCOMES)[number];

export const NEWSLETTER_RECIPIENT_STATUSES = [
  'queued',
  'sent',
  'failed',
  'suppressed',
  'unknown',
] as const;
export type NewsletterRecipientStatus = (typeof NEWSLETTER_RECIPIENT_STATUSES)[number];

export const NEWSLETTER_IMAGE_MODES = ['auto', 'hosted', 'inline', 'none'] as const;
export type NewsletterImageMode = (typeof NEWSLETTER_IMAGE_MODES)[number];

export const EMAIL_SUPPRESSION_REASONS = ['unsubscribed', 'manual'] as const;
export type EmailSuppressionReason = (typeof EMAIL_SUPPRESSION_REASONS)[number];

export const DEFAULT_NEWSLETTER_SUBJECT = "What's new on {{server_name}} ({{end_date}})";

const address = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM');

/** Five fields of digits and the * , - / operators; BullMQ's parser validates the rest at schedule time. */
const CRON_FIELD = /^[\d*,\-/]+$/;
export const cronExpressionSchema = z
  .string()
  .trim()
  .refine((v) => {
    const fields = v.split(/\s+/);
    return fields.length === 5 && fields.every((f) => CRON_FIELD.test(f));
  }, 'Cron needs five fields made of digits, *, comma, dash and slash');

export const newsletterScheduleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('daily'), time }),
  z.strictObject({ kind: z.literal('weekly'), dayOfWeek: z.number().int().min(0).max(6), time }),
  z.strictObject({ kind: z.literal('monthly'), dayOfMonth: z.number().int().min(1).max(28), time }),
  z.strictObject({ kind: z.literal('cron'), expression: cronExpressionSchema }),
]);
export type NewsletterSchedule = z.infer<typeof newsletterScheduleSchema>;

const days = z.number().int().min(1).max(NEWSLETTER_WINDOW_MAX_DAYS);
export const newsletterWindowSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('since_last_send'), fallbackDays: days }),
  z.strictObject({ kind: z.literal('fixed'), days }),
]);
export type NewsletterWindow = z.infer<typeof newsletterWindowSchema>;

const cap = z.number().int().min(1).max(NEWSLETTER_SECTION_MAX);
export const newsletterSectionsSchema = z.strictObject({
  movies: z.strictObject({ enabled: z.boolean(), max: cap }),
  shows: z.strictObject({
    enabled: z.boolean(),
    max: cap,
    maxSeasonsPerShow: z.number().int().min(1).max(NEWSLETTER_SEASONS_PER_SHOW_MAX),
  }),
  music: z.strictObject({ enabled: z.boolean(), max: cap }),
  mostWatched: z.strictObject({
    enabled: z.boolean(),
    max: z.number().int().min(1).max(NEWSLETTER_MOST_WATCHED_MAX),
  }),
});
export type NewsletterSections = z.infer<typeof newsletterSectionsSchema>;

export const DEFAULT_NEWSLETTER_SECTIONS: NewsletterSections = {
  movies: { enabled: true, max: 12 },
  shows: { enabled: true, max: 12, maxSeasonsPerShow: 8 },
  music: { enabled: true, max: 8 },
  mostWatched: { enabled: false, max: 10 },
};

export const newsletterScopeSchema = z.strictObject({
  serverIds: z.array(uuidSchema).max(50).default([]),
  libraryIds: z.array(z.string().min(1).max(100)).max(200).default([]),
});
export type NewsletterScope = z.infer<typeof newsletterScopeSchema>;

export const newsletterRecipientsSchema = z.strictObject({
  members: z.boolean().default(true),
  extraAddresses: z
    .array(z.strictObject({ address, name: z.string().trim().max(100).optional() }))
    .max(NEWSLETTER_EXTRA_ADDRESSES_MAX)
    .default([]),
});
export type NewsletterRecipients = z.infer<typeof newsletterRecipientsSchema>;

export const createNewsletterSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  destinationId: uuidSchema.nullable().default(null),
  schedule: newsletterScheduleSchema,
  timezone: timezoneSchema.unwrap(),
  window: newsletterWindowSchema.default({ kind: 'since_last_send', fallbackDays: 7 }),
  scope: newsletterScopeSchema.default({ serverIds: [], libraryIds: [] }),
  sections: newsletterSectionsSchema.default(DEFAULT_NEWSLETTER_SECTIONS),
  subject: z.string().trim().min(1).max(200).default(DEFAULT_NEWSLETTER_SUBJECT),
  intro: z.string().trim().max(2000).nullable().default(null),
  outro: z.string().trim().max(2000).nullable().default(null),
  recipients: newsletterRecipientsSchema.default({ members: true, extraAddresses: [] }),
  imageMode: z.enum(NEWSLETTER_IMAGE_MODES).default('auto'),
  skipWhenEmpty: z.boolean().default(true),
});
export type CreateNewsletterInput = z.infer<typeof createNewsletterSchema>;

type WithoutDefaults<T extends z.ZodRawShape> = {
  [K in keyof T]: z.ZodOptional<T[K] extends z.ZodDefault<infer Inner> ? Inner : T[K]>;
};

function partialWithoutDefaults<T extends z.ZodRawShape>(shape: T): WithoutDefaults<T> {
  return Object.fromEntries(
    Object.entries(shape).map(([key, field]) => [
      key,
      (field instanceof z.ZodDefault
        ? (field as z.ZodDefault<z.ZodType>).unwrap()
        : (field as z.ZodType)
      ).optional(),
    ])
  ) as unknown as WithoutDefaults<T>;
}

/** A PATCH body: absent keys stay absent instead of resetting to the create defaults. */
export const updateNewsletterSchema = z.strictObject(
  partialWithoutDefaults(createNewsletterSchema.shape)
);
export type UpdateNewsletterInput = z.infer<typeof updateNewsletterSchema>;

export const newsletterTestSendSchema = z.strictObject({ address });
export const emailSuppressionCreateSchema = z.strictObject({ address });
export const newsletterSendsQuerySchema = paginationSchema;

export const EMAIL_LOGO_MODES = ['tracearr', 'none', 'url'] as const;
export type EmailLogoMode = (typeof EMAIL_LOGO_MODES)[number];

/** The web palette's primary as hex; packages/emails ships the same value as DEFAULT_ACCENT. */
const DEFAULT_ACCENT_COLOR = '#0ea0b3';
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Expected a hex color like #0ea0b3');

/** z.url() strips embedded CR/LF and parses what's left, so control characters are rejected before the URL parse ever sees them. */
const logoUrl = z
  .string()
  // eslint-disable-next-line no-control-regex -- matching control characters is the point of this check
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value), {
    message: 'URL must not contain control characters',
  })
  .pipe(z.url({ protocol: /^https?$/ }).max(500));

export const emailBrandingSchema = z.strictObject({
  /** Null means the first server in the newsletter's scope, resolved at render time. */
  senderName: z.string().trim().min(1).max(100).nullable().default(null),
  logo: z
    .discriminatedUnion('mode', [
      z.strictObject({ mode: z.literal('tracearr') }),
      z.strictObject({ mode: z.literal('none') }),
      z.strictObject({ mode: z.literal('url'), url: logoUrl }),
    ])
    .default({ mode: 'tracearr' }),
  accentColor: hexColor.default(DEFAULT_ACCENT_COLOR),
  footerText: z.string().trim().max(500).nullable().default(null),
  postalAddress: z.string().trim().max(500).nullable().default(null),
  mailtoUnsubscribe: z.boolean().default(false),
});
export type EmailBrandingSettings = z.infer<typeof emailBrandingSchema>;
export const DEFAULT_EMAIL_BRANDING: EmailBrandingSettings = emailBrandingSchema.parse({});

export const NEWSLETTER_VIEW_TOKEN_LENGTH = 43;
export const NEWSLETTER_SNAPSHOT_RETENTION_DAYS = 90;
export const NEWSLETTER_SEND_RETENTION_DAYS = 365;

export interface NewsletterSendHtml {
  subject: string;
  html: string;
}

export function newsletterCron(schedule: NewsletterSchedule): string {
  if (schedule.kind === 'cron') return schedule.expression;
  const [hh, mm] = schedule.time.split(':').map(Number) as [number, number];
  switch (schedule.kind) {
    case 'daily':
      return `${mm} ${hh} * * *`;
    case 'weekly':
      return `${mm} ${hh} * * ${schedule.dayOfWeek}`;
    case 'monthly':
      return `${mm} ${hh} ${schedule.dayOfMonth} * *`;
  }
}

/** API shapes. Dates are ISO strings. */
export interface NewsletterSendSummary {
  id: string;
  trigger: NewsletterSendTrigger;
  outcome: NewsletterSendOutcome;
  windowStart: string;
  windowEnd: string;
  recipientCount: number;
  itemCounts: Record<string, number>;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  hasSnapshot: boolean;
}

export interface Newsletter {
  id: string;
  name: string;
  enabled: boolean;
  destinationId: string | null;
  schedule: NewsletterSchedule;
  timezone: string;
  window: NewsletterWindow;
  scope: NewsletterScope;
  sections: NewsletterSections;
  subject: string;
  intro: string | null;
  outro: string | null;
  recipients: NewsletterRecipients;
  imageMode: NewsletterImageMode;
  skipWhenEmpty: boolean;
  createdAt: string;
  updatedAt: string;
  lastSend: NewsletterSendSummary | null;
  nextRunAt: string | null;
}

export interface NewsletterSendRecipient {
  id: string;
  address: string;
  userId: string | null;
  status: NewsletterRecipientStatus;
  attempts: number;
  error: string | null;
  sentAt: string | null;
}

export interface NewsletterSendDetail extends NewsletterSendSummary {
  recipients: NewsletterSendRecipient[];
}

export interface EmailSuppression {
  address: string;
  reason: EmailSuppressionReason;
  sourceSendId: string | null;
  createdAt: string;
}

export interface NewsletterPreview {
  subject: string;
  html: string;
  counts: Record<string, number>;
  window: { start: string; end: string };
  recipients: { resolved: number; missingEmail: number; suppressed: number };
}
