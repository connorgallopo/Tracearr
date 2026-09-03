import { z } from 'zod';

export type TriggerContext = 'session' | 'account' | 'media' | 'server' | 'install';

/**
 * What each context sits under. `media` names a server and no account, so the
 * contexts are a tree rather than a line and `install` is its root.
 */
const TRIGGER_CONTEXT_PARENT: Record<TriggerContext, TriggerContext | null> = {
  session: 'account',
  account: 'server',
  media: 'server',
  server: 'install',
  install: null,
};

/** Whether a trigger of this context carries everything `requires` names. */
export function contextSupplies(context: TriggerContext, requires: TriggerContext): boolean {
  for (let at: TriggerContext | null = context; at; at = TRIGGER_CONTEXT_PARENT[at]) {
    if (at === requires) return true;
  }
  return false;
}

/** The narrowest context both supply: their lowest common ancestor in the tree. */
function meet(a: TriggerContext, b: TriggerContext): TriggerContext {
  for (let at: TriggerContext | null = b; at; at = TRIGGER_CONTEXT_PARENT[at]) {
    if (contextSupplies(a, at)) return at;
  }
  // Unreachable: every chain ends at the root, which supplies nothing and is shared.
  return 'install';
}

const SESSION_VARS = [
  'user.username',
  'user.identityName',
  'session.mediaTitle',
  'session.mediaType',
  'server.name',
  'server.type',
] as const;
const ACCOUNT_VARS = ['user.username', 'user.identityName', 'server.name', 'server.type'] as const;
const SERVER_VARS = ['server.name', 'server.type'] as const;
/** `server.name` doubles `media.server` so an automation that also carries a server trigger keeps one. */
const MEDIA_VARS = [
  'media.title',
  'media.name',
  'media.show',
  'media.season',
  'media.episode',
  'media.episodeCount',
  'media.type',
  'media.year',
  'media.library',
  'media.server',
  'server.name',
  'server.type',
] as const;
const MEDIA_QUALITY_VARS = [
  'media.from.resolution',
  'media.to.resolution',
  'media.from.dynamicRange',
  'media.to.dynamicRange',
  'media.from.videoCodec',
  'media.to.videoCodec',
  'media.from.audioCodec',
  'media.to.audioCodec',
  'media.from.audioChannels',
  'media.to.audioChannels',
  'media.from.fileSize',
  'media.to.fileSize',
] as const;

/** What a trigger is about, and what the list filters on. */
export const TRIGGER_GROUPS = ['sessions', 'accounts', 'library', 'servers', 'updates'] as const;
export type TriggerGroup = (typeof TRIGGER_GROUPS)[number];

export const TRIGGERS = {
  'session.started': { context: 'session', group: 'sessions', variables: SESSION_VARS },
  'session.first_seen': { context: 'session', group: 'sessions', variables: SESSION_VARS },
  'session.stopped': {
    context: 'session',
    group: 'sessions',
    variables: [...SESSION_VARS, 'durationMinutes'],
  },
  'session.transcode_changed': { context: 'session', group: 'sessions', variables: SESSION_VARS },
  'session.paused': { context: 'session', group: 'sessions', variables: SESSION_VARS },
  'session.held_for': {
    context: 'session',
    group: 'sessions',
    variables: [...SESSION_VARS, 'minutes'],
  },
  'account.inactive_for': {
    context: 'account',
    group: 'accounts',
    variables: [...ACCOUNT_VARS, 'days'],
  },
  'account.new_device': {
    context: 'session',
    group: 'accounts',
    variables: [
      ...SESSION_VARS,
      'device.name',
      'device.platform',
      'device.product',
      'device.location',
    ],
  },
  'account.trust_changed': {
    context: 'account',
    group: 'accounts',
    variables: [...ACCOUNT_VARS, 'trust.previous', 'trust.new', 'trust.reason'],
  },
  'media.added': { context: 'media', group: 'library', variables: MEDIA_VARS },
  'media.upgraded': {
    context: 'media',
    group: 'library',
    variables: [...MEDIA_VARS, ...MEDIA_QUALITY_VARS],
  },
  'server.down': { context: 'server', group: 'servers', variables: SERVER_VARS },
  'server.up': { context: 'server', group: 'servers', variables: SERVER_VARS },
  'plugin.update_available': {
    context: 'server',
    group: 'updates',
    variables: [...SERVER_VARS, 'installedVersion', 'latestVersion', 'downloadUrl'],
  },
  'server.update_available': {
    context: 'server',
    group: 'updates',
    variables: [...SERVER_VARS, 'installedVersion', 'latestVersion', 'releaseUrl'],
  },
  'tracearr.update_available': {
    context: 'install',
    group: 'updates',
    variables: ['current', 'latest', 'releaseUrl'],
  },
} as const satisfies Record<
  string,
  { context: TriggerContext; group: TriggerGroup; variables: readonly string[] }
>;

export type TriggerType = keyof typeof TRIGGERS;
export const TRIGGER_TYPES = Object.keys(TRIGGERS) as TriggerType[];

/** Triggers a violation is never about: nobody did anything wrong by picking up a new phone. */
export const NOTIFICATION_ONLY_TRIGGERS = [
  'account.new_device',
  'account.trust_changed',
] as const satisfies readonly TriggerType[];

type ParamlessTriggerType = Exclude<TriggerType, 'session.held_for' | 'account.inactive_for'>;

const PARAMLESS_TRIGGER_TYPES = TRIGGER_TYPES.filter(
  (type): type is ParamlessTriggerType =>
    type !== 'session.held_for' && type !== 'account.inactive_for'
);

// z.uuid() rather than schemas.ts's uuidSchema: schemas.ts re-exports this directory's
// condition and action schemas, and importing back would read the binding before it exists.
const nodeBase = { id: z.uuid(), enabled: z.boolean() };

export const heldForParamsSchema = z.strictObject({
  minutes: z.number().int().min(1).max(1440),
  measure: z.enum(['current', 'total']),
});
export const inactiveForParamsSchema = z.strictObject({
  days: z.number().int().min(1).max(3650),
});

export const triggerNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...nodeBase, type: z.enum(PARAMLESS_TRIGGER_TYPES) }),
  z.strictObject({ ...nodeBase, type: z.literal('session.held_for'), params: heldForParamsSchema }),
  z.strictObject({
    ...nodeBase,
    type: z.literal('account.inactive_for'),
    params: inactiveForParamsSchema,
  }),
]);
export type TriggerNode = z.infer<typeof triggerNodeSchema>;

/** The most demanding context every enabled trigger can satisfy; null when nothing is enabled. */
export function contextOf(triggers: readonly TriggerNode[]): TriggerContext | null {
  let shared: TriggerContext | null = null;
  for (const trigger of triggers) {
    if (!trigger.enabled) continue;
    const context = TRIGGERS[trigger.type].context;
    shared = shared === null ? context : meet(shared, context);
  }
  return shared;
}

/** The variables every enabled trigger offers, so a template renders whichever one fired. */
export function variablesFor(triggers: readonly TriggerNode[]): string[] {
  const sets = triggers
    .filter((trigger) => trigger.enabled)
    .map((trigger) => new Set<string>(TRIGGERS[trigger.type].variables));
  const first = sets[0];
  if (!first) return [];
  return [...first].filter((variable) => sets.every((set) => set.has(variable)));
}
