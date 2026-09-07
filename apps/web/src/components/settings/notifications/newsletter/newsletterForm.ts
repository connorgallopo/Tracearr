import {
  DEFAULT_NEWSLETTER_LINKS,
  DEFAULT_NEWSLETTER_SECTIONS,
  DEFAULT_NEWSLETTER_SUBJECT,
  createNewsletterSchema,
  type CreateNewsletterInput,
  type Newsletter,
  type UpdateNewsletterInput,
} from '@tracearr/shared';
import type { RichTextChange } from '@/components/ui/rich-text-normalize';
import { browserTimeZone } from '@/components/settings/shared/TimezoneSelect';

export type NewsletterFormState = CreateNewsletterInput;
export type FieldErrors = Partial<Record<keyof NewsletterFormState, string>>;
export type RichTextErrors = Partial<Record<'intro' | 'outro', string>>;

export interface FieldsetProps {
  state: NewsletterFormState;
  onChange: (patch: Partial<NewsletterFormState>) => void;
  errors: FieldErrors;
  mode: 'create' | 'edit';
}

export type RichTextHandler = (field: 'intro' | 'outro', change: RichTextChange) => void;

export const NEWSLETTER_FIELD_IDS = {
  name: 'newsletter-name',
  enabled: 'newsletter-enabled',
  scheduleKind: 'newsletter-schedule-kind',
  dayOfWeek: 'newsletter-day-of-week',
  dayOfMonth: 'newsletter-day-of-month',
  time: 'newsletter-time',
  timezone: 'newsletter-timezone',
  cron: 'newsletter-cron',
  windowKind: 'newsletter-window-kind',
  windowDays: 'newsletter-window-days',
  servers: 'newsletter-servers',
  libraries: 'newsletter-libraries',
  senderName: 'newsletter-sender-name',
  subject: 'newsletter-subject',
  intro: 'newsletter-intro',
  outro: 'newsletter-outro',
} as const;

export function defaultFormState(): NewsletterFormState {
  return {
    name: '',
    enabled: true,
    destinationId: null,
    schedule: { kind: 'weekly', dayOfWeek: 1, time: '09:00' },
    timezone: browserTimeZone(),
    window: { kind: 'since_last_send', fallbackDays: 7 },
    scope: { serverIds: [], libraries: [] },
    sections: DEFAULT_NEWSLETTER_SECTIONS,
    subject: DEFAULT_NEWSLETTER_SUBJECT,
    senderName: null,
    intro: null,
    outro: null,
    recipients: { members: true, extraAddresses: [], excludeUserIds: [] },
    imageMode: 'auto',
    skipWhenEmpty: true,
    links: DEFAULT_NEWSLETTER_LINKS,
  };
}

export function seedFromNewsletter(row: Newsletter): NewsletterFormState {
  const { id: _id, createdAt: _c, updatedAt: _u, lastSend: _l, nextRunAt: _n, ...rest } = row;
  return rest;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!deepEqual(left[key], right[key])) return false;
  return true;
}

/** Only the keys whose value moved, so a PATCH never resends what the row already holds. */
export function diffPatch(
  seed: NewsletterFormState,
  state: NewsletterFormState
): UpdateNewsletterInput {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(state) as (keyof NewsletterFormState)[]) {
    if (!deepEqual(seed[key], state[key])) patch[key] = state[key];
  }
  return patch as UpdateNewsletterInput;
}

/** The shared create schema is the one source of rules; the first issue per top-level field is what the form shows. */
export function validateForm(state: NewsletterFormState): FieldErrors {
  const parsed = createNewsletterSchema.safeParse(state);
  if (parsed.success) return {};
  const errors: FieldErrors = {};
  for (const issue of parsed.error.issues) {
    const key = issue.path[0];
    if (typeof key !== 'string') continue;
    const field = key as keyof NewsletterFormState;
    if (errors[field] === undefined) errors[field] = issue.message;
  }
  return errors;
}

export function prefillFromRouterState(state: unknown): Partial<NewsletterFormState> {
  if (typeof state !== 'object' || state === null) return {};
  const { destinationId } = state as { destinationId?: unknown };
  return typeof destinationId === 'string' ? { destinationId } : {};
}
