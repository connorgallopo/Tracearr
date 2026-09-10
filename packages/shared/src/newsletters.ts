import { z } from 'zod';
import {
  emailRichTextDocSchema,
  normalizeEmailRichText,
  type EmailRichTextDoc,
} from './emailRichText.js';
import { paginationSchema, timezoneSchema, uuidSchema } from './schemas.js';

/** 12 is the largest cap at which the heaviest digest the assembler can emit stays clear of Gmail's 102 KB clip, proven by the size gate in packages/emails. */
export const NEWSLETTER_SECTION_MAX = 12;
export const NEWSLETTER_MOST_WATCHED_MAX = 10;
export const NEWSLETTER_SEASONS_PER_SHOW_MAX = 8;
export const NEWSLETTER_WINDOW_MAX_DAYS = 31;
export const NEWSLETTER_EXTRA_ADDRESSES_MAX = 200;
export const NEWSLETTER_EXCLUDED_USERS_MAX = 200;
export const NEWSLETTER_SENDER_NAME_MAX = 100;

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

export const NEWSLETTER_SCOPE_LIBRARIES_MAX = 200;

/** A library id is only unique with its server: Plex section ids start at 1 on every server. */
export const newsletterScopeLibrarySchema = z.strictObject({
  serverId: uuidSchema,
  libraryId: z.string().min(1).max(100),
});
export type NewsletterScopeLibrary = z.infer<typeof newsletterScopeLibrarySchema>;

export const newsletterScopeSchema = z.strictObject({
  serverIds: z.array(uuidSchema).max(50).default([]),
  libraries: z.array(newsletterScopeLibrarySchema).max(NEWSLETTER_SCOPE_LIBRARIES_MAX).default([]),
});
export type NewsletterScope = z.infer<typeof newsletterScopeSchema>;

export const newsletterRecipientsSchema = z.strictObject({
  members: z.boolean().default(true),
  extraAddresses: z
    .array(z.strictObject({ address, name: z.string().trim().max(100).optional() }))
    .max(NEWSLETTER_EXTRA_ADDRESSES_MAX)
    .default([]),
  excludeUserIds: z.array(uuidSchema).max(NEWSLETTER_EXCLUDED_USERS_MAX).default([]),
});
export type NewsletterRecipients = z.infer<typeof newsletterRecipientsSchema>;

export const newsletterLinksSchema = z.strictObject({ tracearr: z.boolean() });
export type NewsletterLinks = z.infer<typeof newsletterLinksSchema>;
export const DEFAULT_NEWSLETTER_LINKS: NewsletterLinks = { tracearr: false };

const richTextField = emailRichTextDocSchema
  .nullable()
  .transform((doc) => normalizeEmailRichText(doc))
  .default(null);

export const createNewsletterSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  enabled: z.boolean().default(true),
  destinationId: uuidSchema.nullable().default(null),
  schedule: newsletterScheduleSchema,
  timezone: timezoneSchema.unwrap(),
  window: newsletterWindowSchema.default({ kind: 'since_last_send', fallbackDays: 7 }),
  scope: newsletterScopeSchema.default({ serverIds: [], libraries: [] }),
  sections: newsletterSectionsSchema.default(DEFAULT_NEWSLETTER_SECTIONS),
  subject: z.string().trim().min(1).max(200).default(DEFAULT_NEWSLETTER_SUBJECT),
  senderName: z.string().trim().min(1).max(NEWSLETTER_SENDER_NAME_MAX).nullable().default(null),
  intro: richTextField,
  outro: richTextField,
  recipients: newsletterRecipientsSchema.default({
    members: true,
    extraAddresses: [],
    excludeUserIds: [],
  }),
  imageMode: z.enum(NEWSLETTER_IMAGE_MODES).default('auto'),
  skipWhenEmpty: z.boolean().default(true),
  links: newsletterLinksSchema.default(DEFAULT_NEWSLETTER_LINKS),
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

/** The set of a newsletter's servers a person belongs to, as one string: the ids deduped, sorted and joined by a comma. */
export function variantKey(serverIds: readonly string[]): string {
  return [...new Set(serverIds)].sort().join(',');
}

/** The scoped servers a member has an account on, in the scope's order; every scoped server for null, an extra address that belongs to no server. */
export function variantServerIds(
  memberServerIds: readonly string[] | null,
  scopedServerIds: readonly string[]
): string[] {
  if (memberServerIds === null) return [...scopedServerIds];
  return scopedServerIds.filter((id) => memberServerIds.includes(id));
}

/** A digest that covers several servers has no natural sender name, so the editor asks for one before the Tracearr fallback could fire. */
export function needsSenderName(senderName: string | null, scopedServerCount: number): boolean {
  return !senderName && scopedServerCount > 1;
}

/** The shape variantKey() produces; anything else is refused before a send looks the variant up. */
export const variantKeySchema = z
  .string()
  .max(50 * 37)
  .refine(
    (key) =>
      key.split(',').every((id) => uuidSchema.safeParse(id).success) &&
      variantKey(key.split(',')) === key,
    'variantKey must be sorted, comma-separated server ids'
  );

export const newsletterTestSendSchema = z.strictObject({
  address,
  variantKey: variantKeySchema.optional(),
});
/** POST /newsletters/preview: the form as the create route would receive it, plus the saved row's id when editing so the window starts at its watermark. */
export const newsletterPreviewDraftSchema = z.strictObject({
  newsletterId: uuidSchema.optional(),
  newsletter: createNewsletterSchema,
});
export type NewsletterPreviewDraftInput = z.infer<typeof newsletterPreviewDraftSchema>;

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
/** A block an older build wrote may carry keys this one dropped; the read path strips them instead of resetting to defaults. */
export const emailBrandingReadSchema = z.object(emailBrandingSchema.shape);

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

/** Null means the scoped server's name when the scope resolves to exactly one server; several servers have no natural name. */
export function resolveSenderName(senderName: string | null, scopedServerNames: string[]): string {
  if (senderName) return senderName;
  const [only] = scopedServerNames;
  return scopedServerNames.length === 1 && only !== undefined ? only : 'Tracearr';
}

/** What one set of the newsletter's servers received: who, how much was trimmed to fit, how big, or that nothing was new there. */
export interface NewsletterSendVariant {
  key: string;
  serverIds: string[];
  serverNames: string[];
  /** Deliverable recipients in this variant. */
  recipientCount: number;
  trimmed: NewsletterSectionCounts;
  bytes: number;
  /** Nothing new in the window for these servers: no snapshot, nobody in the variant was mailed. */
  empty: boolean;
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
  variants: NewsletterSendVariant[];
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
  senderName: string | null;
  intro: EmailRichTextDoc | null;
  outro: EmailRichTextDoc | null;
  recipients: NewsletterRecipients;
  imageMode: NewsletterImageMode;
  skipWhenEmpty: boolean;
  links: NewsletterLinks;
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
  variantKey: string;
  attempts: number;
  error: string | null;
  sentAt: string | null;
}

export interface NewsletterSendDetail extends NewsletterSendSummary {
  recipients: NewsletterSendRecipient[];
}

export interface NewsletterSendsPage {
  sends: NewsletterSendSummary[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NewsletterRecipientPerson {
  userId: string;
  /** The person's oldest account on a scoped server; the identity PATCH route and the user page key on it. */
  serverUserId: string;
  name: string | null;
  username: string | null;
  serverId: string;
  serverName: string;
  thumbUrl: string | null;
  /** Every scoped server this person has an active account on, oldest account first. */
  serverIds: string[];
}

export const NEWSLETTER_EXCLUDED_REASONS = ['excluded', 'banned', 'pending', 'noServer'] as const;
export type NewsletterExcludedReason = (typeof NEWSLETTER_EXCLUDED_REASONS)[number];

/** Why a person with an account on a scoped server is not on the list: the owner excluded them, or their identity is banned or still pending. */
export interface NewsletterExcludedPerson extends NewsletterRecipientPerson {
  reason: NewsletterExcludedReason;
}

export interface NewsletterResolvedRecipient {
  address: string;
  userId: string | null;
  serverUserId: string | null;
  name: string | null;
  suppressed: boolean;
  serverId: string | null;
  username: string | null;
  serverName: string | null;
  thumbUrl: string | null;
  /** Every scoped server the person has an account on; empty for an extra address. */
  serverIds: string[];
}

/** GET /newsletters/:id/recipients: who the next send reaches, who has no address, and who the owner excluded. */
export interface NewsletterRecipientsView {
  recipients: NewsletterResolvedRecipient[];
  missing: NewsletterRecipientPerson[];
  excluded: NewsletterExcludedPerson[];
}

export interface EmailSuppression {
  address: string;
  reason: EmailSuppressionReason;
  sourceSendId: string | null;
  sourceNewsletterId: string | null;
  createdAt: string;
}

/** Cards a section holds, albums counted across artists; also the shape of what the render-time fit loop removed per section. */
export interface NewsletterSectionCounts {
  movies: number;
  shows: number;
  albums: number;
  mostWatched: number;
}

export interface NewsletterPreviewVariant {
  key: string;
  serverIds: string[];
  serverNames: string[];
  /** Deliverable recipients in this variant. */
  recipientCount: number;
  subject: string;
  html: string;
  counts: Record<string, number>;
  /** Items the fit loop removed so the email stays under the clip budget; each shows in its section's "+N more" line. */
  trimmed: NewsletterSectionCounts;
}

export interface NewsletterPreview {
  /** fromWatermark is true when a since_last_send window started at the last counted send rather than the fallback days. */
  window: { start: string; end: string; fromWatermark: boolean };
  recipients: { resolved: number; missingEmail: number; suppressed: number };
  /** The union of the newsletter's servers first, then one entry per set some recipient belongs to. */
  variants: [NewsletterPreviewVariant, ...NewsletterPreviewVariant[]];
}

/** GET /newsletters/:id/variants: what each set of servers would get from the next send, without rendering. */
export interface NewsletterVariantsView {
  window: { start: string; end: string };
  variants: {
    key: string;
    serverIds: string[];
    serverNames: string[];
    recipientCount: number;
    counts: Record<string, number>;
    isEmpty: boolean;
  }[];
}
