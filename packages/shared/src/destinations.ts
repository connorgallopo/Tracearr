import { z } from 'zod';
import type { NotificationEventType, ViolationSeverity } from './types.js';

export const DESTINATION_KINDS = [
  'discord',
  'json_webhook',
  'ntfy',
  'gotify',
  'apprise',
  'pushover',
  'email',
  'push',
  'web_toast',
] as const;
export type DestinationKind = (typeof DESTINATION_KINDS)[number];

export const NOTIFICATION_EVENT_TYPES = [
  'violation_detected',
  'stream_started',
  'stream_stopped',
  'server_down',
  'server_up',
  'plugin_update_available',
  'server_update_available',
  'tracearr_update_available',
  'media_added',
  'media_upgraded',
  'new_device',
  'trust_score_changed',
  'newsletter_send',
] as const satisfies readonly NotificationEventType[];

/** What a destination may subscribe to on its own; every other event reaches it through an automation. */
export const SUBSCRIBABLE_EVENTS = [
  'violation_detected',
] as const satisfies readonly NotificationEventType[];
export type SubscribableEvent = (typeof SUBSCRIBABLE_EVENTS)[number];

const ALL_EVENTS = NOTIFICATION_EVENT_TYPES;
/** Push has no plugin-update method and the browser has no toast for it. */
const EVENTS_WITHOUT_PLUGIN = Object.freeze(
  NOTIFICATION_EVENT_TYPES.filter((e) => e !== 'plugin_update_available')
);

export interface DestinationFieldOption {
  value: string;
  /** i18n key under pages:settings.destinations.options */
  label: string;
}

export interface DestinationFieldDescriptor {
  key: string;
  /** i18n key under pages:settings.destinations.fields */
  label: string;
  input: 'text' | 'url' | 'secret' | 'select' | 'number' | 'email' | 'emails';
  required: boolean;
  /** Masked on read, kept on omit; every url is secret because webhook urls embed credentials */
  secret: boolean;
  placeholder?: string;
  /** i18n key under pages:settings.destinations.hints, rendered as the field description */
  hint?: string;
  default?: string;
  /** select only */
  options?: readonly DestinationFieldOption[];
  /** number only; validated on the string value, whole non-negative integers regardless of min */
  min?: number;
  max?: number;
  /** text/secret only: overrides the default 2000-char max and adds a format check */
  maxLength?: number;
  pattern?: RegExp;
  /** select only: choosing a value also writes these sibling fields */
  presets?: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** i18n key under pages:settings.destinations.groups; the dialog draws a separator where the group changes */
  group?: string;
}

export interface DestinationDescriptor {
  kind: DestinationKind;
  /** i18n key under pages:settings.destinations.types */
  label: string;
  /** lucide icon name; the web falls back to a generic icon for unknown names */
  icon: string;
  builtin: boolean;
  events: readonly NotificationEventType[];
  fields: readonly DestinationFieldDescriptor[];
}

const url = (key: string, label: string, placeholder: string): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'url',
  required: true,
  secret: true,
  placeholder,
});
const secret = (
  key: string,
  label: string,
  required: boolean,
  hint?: string
): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'secret',
  required,
  secret: true,
  hint,
});
const text = (
  key: string,
  label: string,
  required: boolean,
  placeholder?: string,
  def?: string
): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'text',
  required,
  secret: false,
  placeholder,
  default: def,
});

export const EMAIL_SECURITY = ['starttls', 'tls', 'none'] as const;
export type EmailSecurity = (typeof EMAIL_SECURITY)[number];

/** Host, port and security per provider; the dialog copies them into the sibling fields. usernameHint/passwordHint are i18n keys under pages:settings.destinations.hints, resolved by the dialog rather than copied into the form. */
export const EMAIL_SMTP_PRESETS = {
  postmark: {
    host: 'smtp.postmarkapp.com',
    port: '587',
    security: 'starttls',
    usernameHint: 'smtpPostmarkUsername',
    passwordHint: 'smtpPostmarkPassword',
  },
  resend: {
    host: 'smtp.resend.com',
    port: '465',
    security: 'tls',
    usernameHint: 'smtpResendUsername',
    passwordHint: 'smtpResendPassword',
  },
  ses: {
    host: 'email-smtp.us-east-1.amazonaws.com',
    port: '587',
    security: 'starttls',
    usernameHint: 'smtpSesUsername',
    passwordHint: 'smtpSesPassword',
  },
  mailgun: {
    host: 'smtp.mailgun.org',
    port: '587',
    security: 'starttls',
    usernameHint: 'smtpMailgunUsername',
    passwordHint: 'smtpMailgunPassword',
  },
  sendgrid: {
    host: 'smtp.sendgrid.net',
    port: '587',
    security: 'starttls',
    usernameHint: 'smtpSendgridUsername',
    passwordHint: 'smtpSendgridPassword',
  },
  brevo: {
    host: 'smtp-relay.brevo.com',
    port: '587',
    security: 'starttls',
    usernameHint: 'smtpBrevoUsername',
    passwordHint: 'smtpBrevoPassword',
  },
  gmail: {
    host: 'smtp.gmail.com',
    port: '587',
    security: 'starttls',
    usernameHint: 'smtpGmailUsername',
    passwordHint: 'smtpGmailPassword',
  },
} as const satisfies Record<
  string,
  {
    host: string;
    port: string;
    security: EmailSecurity;
    usernameHint: string;
    passwordHint: string;
  }
>;

const select = (
  key: string,
  label: string,
  options: readonly DestinationFieldOption[],
  def: string,
  extra: { hint?: string; presets?: DestinationFieldDescriptor['presets'] } = {}
): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'select',
  required: true,
  secret: false,
  options,
  default: def,
  ...extra,
});
const number = (
  key: string,
  label: string,
  def: string,
  min: number,
  max: number,
  hint?: string
): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'number',
  required: true,
  secret: false,
  default: def,
  min,
  max,
  hint,
});
const email = (
  key: string,
  label: string,
  required: boolean,
  placeholder?: string
): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'email',
  required,
  secret: false,
  placeholder,
});
const emails = (
  key: string,
  label: string,
  required: boolean,
  placeholder: string,
  hint: string
): DestinationFieldDescriptor => ({
  key,
  label,
  input: 'emails',
  required,
  secret: false,
  placeholder,
  hint,
});
const grouped = (
  group: string,
  fields: readonly DestinationFieldDescriptor[]
): DestinationFieldDescriptor[] => fields.map((field) => ({ ...field, group }));

const PRESET_OPTIONS: readonly DestinationFieldOption[] = [
  { value: 'custom', label: 'presetCustom' },
  { value: 'postmark', label: 'presetPostmark' },
  { value: 'resend', label: 'presetResend' },
  { value: 'ses', label: 'presetSes' },
  { value: 'mailgun', label: 'presetMailgun' },
  { value: 'sendgrid', label: 'presetSendgrid' },
  { value: 'brevo', label: 'presetBrevo' },
  { value: 'gmail', label: 'presetGmail' },
];

const SECURITY_OPTIONS: readonly DestinationFieldOption[] = [
  { value: 'starttls', label: 'securityStarttls' },
  { value: 'tls', label: 'securityTls' },
  { value: 'none', label: 'securityNone' },
];

export const DESTINATION_TYPES = {
  discord: {
    kind: 'discord',
    label: 'discord',
    icon: 'MessageSquare',
    builtin: false,
    events: ALL_EVENTS,
    fields: [url('webhookUrl', 'webhookUrl', 'https://discord.com/api/webhooks/...')],
  },
  json_webhook: {
    kind: 'json_webhook',
    label: 'jsonWebhook',
    icon: 'Webhook',
    builtin: false,
    events: ALL_EVENTS,
    fields: [url('url', 'url', 'https://example.com/webhook')],
  },
  ntfy: {
    kind: 'ntfy',
    label: 'ntfy',
    icon: 'Bell',
    builtin: false,
    events: ALL_EVENTS,
    fields: [
      url('url', 'serverUrl', 'https://ntfy.sh/'),
      text('topic', 'topic', true, 'tracearr', 'tracearr'),
      secret('authToken', 'authToken', false, 'authTokenOptional'),
    ],
  },
  gotify: {
    kind: 'gotify',
    label: 'gotify',
    icon: 'Bell',
    builtin: false,
    events: ALL_EVENTS,
    fields: [url('url', 'serverUrl', 'https://gotify.example.com/message?token=...')],
  },
  apprise: {
    kind: 'apprise',
    label: 'apprise',
    icon: 'Share2',
    builtin: false,
    events: ALL_EVENTS,
    fields: [url('url', 'apiUrl', 'https://apprise.example.com/notify/apprise')],
  },
  pushover: {
    kind: 'pushover',
    label: 'pushover',
    icon: 'Smartphone',
    builtin: false,
    events: ALL_EVENTS,
    fields: [secret('userKey', 'userKey', true), secret('apiToken', 'apiToken', true)],
  },
  email: {
    kind: 'email',
    label: 'email',
    icon: 'Mail',
    builtin: false,
    events: ALL_EVENTS,
    fields: [
      ...grouped('connection', [
        select('preset', 'preset', PRESET_OPTIONS, 'custom', {
          hint: 'smtpPreset',
          presets: EMAIL_SMTP_PRESETS,
        }),
        text('host', 'host', true, 'smtp.example.com'),
        number('port', 'port', '587', 1, 65535),
        select('security', 'security', SECURITY_OPTIONS, 'starttls'),
        { ...text('username', 'username', false), hint: 'smtpUsernameOptional' },
        secret('password', 'password', false),
        number('messagesPerSecond', 'messagesPerSecond', '2', 1, 50, 'smtpRate'),
        {
          ...text('messageStream', 'messageStream', false),
          hint: 'smtpMessageStream',
          maxLength: 64,
          pattern: /^[A-Za-z0-9-]*$/,
        },
      ]),
      ...grouped('sender', [
        text('fromName', 'fromName', false, undefined, 'Tracearr'),
        email('fromAddress', 'fromAddress', true, 'tracearr@example.com'),
        email('replyTo', 'replyTo', false),
      ]),
      ...grouped('alerts', [
        emails('to', 'to', false, 'you@example.com, admin@example.com', 'smtpTo'),
      ]),
    ],
  },
  push: {
    kind: 'push',
    label: 'push',
    icon: 'Smartphone',
    builtin: true,
    events: EVENTS_WITHOUT_PLUGIN,
    fields: [],
  },
  web_toast: {
    kind: 'web_toast',
    label: 'webToast',
    icon: 'Globe',
    builtin: true,
    events: EVENTS_WITHOUT_PLUGIN,
    fields: [],
  },
} as const satisfies Record<DestinationKind, DestinationDescriptor>;

const httpUrl = z
  .string()
  .trim()
  .refine((v) => /^https?:\/\/\S+$/i.test(v), 'Must be an http(s) URL');

const address = z.email();

function isAddress(value: string): boolean {
  return address.safeParse(value).success;
}

export function addressList(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** An optional field may be left blank; a required one gets `.min(1)` after this, so blank fails there. */
function fieldSchema(f: DestinationFieldDescriptor): z.ZodString {
  const blankOk = (check: (v: string) => boolean) => (v: string) =>
    (!f.required && v === '') || check(v);
  switch (f.input) {
    case 'url':
      return httpUrl;
    case 'email':
      return z.string().trim().max(254).refine(blankOk(isAddress), 'Must be an email address');
    case 'emails':
      return z
        .string()
        .trim()
        .max(2000)
        .refine(
          blankOk((v) => addressList(v).length > 0 && addressList(v).every(isAddress)),
          'Must be one or more comma-separated email addresses'
        );
    case 'number': {
      const min = f.min ?? Number.MIN_SAFE_INTEGER;
      const max = f.max ?? Number.MAX_SAFE_INTEGER;
      return z
        .string()
        .trim()
        .refine(
          blankOk((v) => /^\d+$/.test(v) && Number(v) >= min && Number(v) <= max),
          `Must be a whole number between ${min} and ${max}`
        );
    }
    case 'select': {
      const allowed = (f.options ?? []).map((o) => o.value);
      return z.string().refine(
        blankOk((v) => allowed.includes(v)),
        'Must be one of the listed options'
      );
    }
    case 'text':
    case 'secret': {
      const { pattern } = f;
      const base = z
        .string()
        .trim()
        .max(f.maxLength ?? 2000);
      return pattern
        ? base.refine(
            blankOk((v) => pattern.test(v)),
            'Invalid format'
          )
        : base;
    }
  }
}

/** Zod object for a field list; unknown keys rejected. Exported so refinements are testable without a kind. */
export function configSchemaForFields(
  fields: readonly DestinationFieldDescriptor[]
): z.ZodObject<z.ZodRawShape> {
  const shape: Record<string, z.ZodType> = {};
  for (const f of fields) {
    let s = fieldSchema(f);
    if (f.required) s = s.min(1);
    shape[f.key] =
      f.default !== undefined ? s.default(f.default) : f.required ? s : s.optional().nullable();
  }
  return z.strictObject(shape);
}

/** Zod object for one kind's config, built from its descriptor. */
export function destinationConfigSchema(kind: DestinationKind): z.ZodObject<z.ZodRawShape> {
  return configSchemaForFields(DESTINATION_TYPES[kind].fields);
}

export const notificationEventTypeSchema = z.enum(NOTIFICATION_EVENT_TYPES);
const subscribableEventSchema = z.enum(SUBSCRIBABLE_EVENTS);
const nonBuiltinKind = z.enum(DESTINATION_KINDS.filter((k) => !DESTINATION_TYPES[k].builtin));

export const createDestinationSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  type: nonBuiltinKind,
  config: z.record(z.string(), z.unknown()),
  events: z.array(subscribableEventSchema).default([]),
  enabled: z.boolean().default(true),
});

/** Secrets: omitted keeps the stored value, null clears, a string replaces. */
export const updateDestinationSchema = z.strictObject({
  name: z.string().trim().min(1).max(100).optional(),
  config: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
  events: z.array(subscribableEventSchema).optional(),
  enabled: z.boolean().optional(),
});

export type CreateDestinationInput = z.infer<typeof createDestinationSchema>;
export type UpdateDestinationInput = z.infer<typeof updateDestinationSchema>;

/** API shape. `config` carries non-secret values; secret fields are null and listed in `secretsSet` when stored. */
export interface Destination {
  id: string;
  name: string;
  type: DestinationKind;
  enabled: boolean;
  builtin: boolean;
  events: NotificationEventType[];
  configStatus: 'ok' | 'reencrypt';
  config: Record<string, string | null> | null;
  secretsSet: string[];
  referencedByAutomationCount: number;
  referencedByNewsletterCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 200 body of the two test routes. `sentTo` is set by kinds that pick the address themselves. */
export interface DestinationTestResult {
  success: true;
  sentTo?: string;
}

export interface NotificationToast {
  title: string;
  message: string;
  automationId: string;
  automationName: string;
  severity: ViolationSeverity;
}
