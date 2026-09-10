import {
  DEFAULT_NEWSLETTER_LINKS,
  DEFAULT_NEWSLETTER_SECTIONS,
  DEFAULT_NEWSLETTER_SUBJECT,
  createNewsletterSchema,
  needsSenderName,
  type CreateNewsletterInput,
  type Newsletter,
  type NewsletterRecipients,
  type NewsletterScope,
  type UpdateNewsletterInput,
} from '@tracearr/shared';
import type { ZodError } from 'zod';
import type { RichTextChange } from '@/components/ui/rich-text-normalize';
import { browserTimeZone } from '@/components/settings/shared/TimezoneSelect';

export type NewsletterFormState = CreateNewsletterInput;
export type FieldErrors = Partial<Record<keyof NewsletterFormState, string>>;
export type TouchedFields = Partial<Record<keyof NewsletterFormState, boolean>>;
export type RichTextErrors = Partial<Record<'intro' | 'outro', string>>;

export interface FieldsetProps {
  state: NewsletterFormState;
  onChange: (patch: Partial<NewsletterFormState>) => void;
  /** Only what the form may paint: a touched field's error, or every error once Save was pressed. */
  errors: FieldErrors;
  mode: 'create' | 'edit';
  touch: (key: keyof NewsletterFormState) => void;
  touched: TouchedFields;
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
  /** Suffixed with the section name, and `-shows-seasons` for the seasons cap. */
  sectionCap: 'newsletter-section-cap',
  senderName: 'newsletter-sender-name',
  subject: 'newsletter-subject',
  intro: 'newsletter-intro',
  outro: 'newsletter-outro',
  members: 'newsletter-members',
  destination: 'newsletter-destination',
  imageMode: 'newsletter-image-mode',
  skipWhenEmpty: 'newsletter-skip-empty',
  linksTracearr: 'newsletter-links-tracearr',
} as const;

export const RECIPIENTS_CARD_ID = 'newsletter-recipients';

export const DELIVERY_CARD_ID = 'newsletter-delivery';

export interface ValidationMessages {
  required: string;
  maxLength: (max: number) => string;
  senderNameRequired: string;
}

type Issue = ZodError['issues'][number];

/** Zod's own wording is not copy; the two string issues this form can raise get the app's messages. */
function issueMessage(issue: Issue, messages: ValidationMessages | undefined): string {
  if (!messages) return issue.message;
  if (issue.code === 'too_small' && issue.origin === 'string') return messages.required;
  if (issue.code === 'too_big' && issue.origin === 'string')
    return messages.maxLength(Number(issue.maximum));
  return issue.message;
}

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
    imageMode: 'inline',
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

/** The shared create schema is the one source of rules; the first issue per top-level field is what the form shows. The sender-name rule needs the resolved server count, which only the editor has. */
export function validateForm(
  state: NewsletterFormState,
  opts?: { scopedServerCount: number; messages: ValidationMessages }
): FieldErrors {
  const parsed = createNewsletterSchema.safeParse(state);
  const errors: FieldErrors = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (typeof key !== 'string') continue;
      const field = key as keyof NewsletterFormState;
      if (errors[field] === undefined) errors[field] = issueMessage(issue, opts?.messages);
    }
  }
  if (
    opts &&
    errors.senderName === undefined &&
    needsSenderName(state.senderName, opts.scopedServerCount)
  ) {
    errors.senderName = opts.messages.senderNameRequired;
  }
  return errors;
}

export function visibleErrors(
  errors: FieldErrors,
  touched: TouchedFields,
  submitted: boolean
): FieldErrors {
  if (submitted) return errors;
  const shown: FieldErrors = {};
  for (const key of Object.keys(errors) as (keyof NewsletterFormState)[]) {
    if (touched[key]) shown[key] = errors[key];
  }
  return shown;
}

/** Top-level fields in the order the cards render them, so the first error on the page is the one that gets focus. */
const FIELD_ORDER: (keyof NewsletterFormState)[] = [
  'name',
  'enabled',
  'schedule',
  'timezone',
  'window',
  'scope',
  'sections',
  'senderName',
  'subject',
  'intro',
  'outro',
  'recipients',
  'destinationId',
  'imageMode',
  'skipWhenEmpty',
  'links',
];

export function firstInvalidField(errors: FieldErrors): keyof NewsletterFormState | null {
  return FIELD_ORDER.find((field) => errors[field] !== undefined) ?? null;
}

/** The DOM id of the control that answers for a field's error. */
export function focusTargetId(
  field: keyof NewsletterFormState,
  state: NewsletterFormState
): string {
  switch (field) {
    case 'name':
      return NEWSLETTER_FIELD_IDS.name;
    case 'enabled':
      return NEWSLETTER_FIELD_IDS.enabled;
    case 'schedule':
      return state.schedule.kind === 'cron' ? NEWSLETTER_FIELD_IDS.cron : NEWSLETTER_FIELD_IDS.time;
    case 'timezone':
      return NEWSLETTER_FIELD_IDS.timezone;
    case 'window':
      return NEWSLETTER_FIELD_IDS.windowDays;
    case 'scope':
      return NEWSLETTER_FIELD_IDS.servers;
    case 'sections':
      return `${NEWSLETTER_FIELD_IDS.sectionCap}-movies`;
    case 'senderName':
      return NEWSLETTER_FIELD_IDS.senderName;
    case 'subject':
      return NEWSLETTER_FIELD_IDS.subject;
    case 'intro':
      return NEWSLETTER_FIELD_IDS.intro;
    case 'outro':
      return NEWSLETTER_FIELD_IDS.outro;
    case 'recipients':
      return NEWSLETTER_FIELD_IDS.members;
    case 'destinationId':
      return NEWSLETTER_FIELD_IDS.destination;
    case 'imageMode':
      return NEWSLETTER_FIELD_IDS.imageMode;
    case 'skipWhenEmpty':
      return NEWSLETTER_FIELD_IDS.skipWhenEmpty;
    case 'links':
      return NEWSLETTER_FIELD_IDS.linksTracearr;
  }
}

/** The servers a scope resolves to, in the scope's own order; every server when it names none. */
export function scopedServers<T extends { id: string }>(
  scope: Pick<NewsletterScope, 'serverIds'>,
  servers: readonly T[]
): T[] {
  if (scope.serverIds.length === 0) return [...servers];
  return scope.serverIds.flatMap((id) => {
    const server = servers.find((s) => s.id === id);
    return server ? [server] : [];
  });
}

/** The form's servers no longer match the saved row's, so anything resolved from the saved row answers for the old ones. */
export function scopeMoved(savedServerIds: string[] | null, serverIds: string[]): boolean {
  return savedServerIds !== null && !deepEqual(savedServerIds, serverIds);
}

/** Only a saved newsletter with Members on has a member list to resolve; anything else has nothing to ask for. */
export function recipientsQueryId(
  form: NewsletterRecipients,
  newsletterId: string | null
): string | undefined {
  return form.members && newsletterId ? newsletterId : undefined;
}

export function prefillFromRouterState(state: unknown): Partial<NewsletterFormState> {
  if (typeof state !== 'object' || state === null) return {};
  const { destinationId } = state as { destinationId?: unknown };
  return typeof destinationId === 'string' ? { destinationId } : {};
}
