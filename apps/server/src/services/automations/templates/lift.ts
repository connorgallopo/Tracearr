/**
 * Export: strip this install's ids out of an automation, then seal what is left
 * as an envelope with its share code.
 */

import {
  AUTOMATION_NAME_MAX,
  TEMPLATE_SCHEMA_VERSION,
  fingerprintOf,
  liftAutomation,
  templateEnvelopeSchema,
  templateMinServerVersion,
  type TEMPLATE_GROUPS,
  type TemplateEnvelope,
} from '@tracearr/shared';
import { firstIssueMessage } from '../../../utils/zod.js';
import { type AutomationRow } from '../versions.js';
import { encodeTemplateCode } from './shareCode.js';
import { sha256Hex } from './store.js';

export type ExportResult =
  { ok: true; envelope: TemplateEnvelope; code: string } | { ok: false; reason: string };

/** Kebab and at most 64 characters; the importing install suffixes it on a collision. */
function slugFor(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug || 'automation';
}

/** A default instance name that hit the column cap kept only the front of its " — server" tail. */
function stripServerSuffix(name: string, suffix: string): string {
  if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  if (name.length !== AUTOMATION_NAME_MAX) return name;
  const cut = name.lastIndexOf(' — ');
  return cut !== -1 && suffix.startsWith(name.slice(cut)) ? name.slice(0, cut) : name;
}

/** An instance bound to a server carries its name in the title; the export never does. */
function exportedName(name: string, serverName: string | null | undefined): string {
  const stripped =
    serverName === null || serverName === undefined
      ? name
      : stripServerSuffix(name, ` — ${serverName}`);
  // Automation names and descriptions are allowed more room than an envelope has.
  return stripped.slice(0, 80);
}

export function exportEnvelope(
  automation: AutomationRow,
  context: {
    author?: string;
    group?: (typeof TEMPLATE_GROUPS)[number];
    serverName?: string | null;
  }
): ExportResult {
  const lifted = liftAutomation({
    name: automation.name,
    kind: automation.kind,
    severity: automation.severity,
    triggers: automation.triggers ?? [],
    conditions: automation.conditions ?? { groups: [] },
    actions: automation.actions ?? { actions: [] },
    serverId: automation.serverId,
    serverUserId: automation.serverUserId,
    userId: automation.userId,
    enforceAcrossServers: automation.enforceAcrossServers,
    cooldownMinutes: automation.cooldownMinutes,
  });

  const name = exportedName(automation.name, context.serverName);
  const parsed = templateEnvelopeSchema.safeParse({
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    slug: slugFor(name),
    name,
    description: (automation.description ?? '').slice(0, 300),
    group: context.group ?? (automation.kind === 'notification' ? 'notifications' : 'policies'),
    kind: automation.kind,
    ...(context.author === undefined ? {} : { author: context.author }),
    minServerVersion: templateMinServerVersion(lifted),
    inputs: lifted.inputs,
    definition: lifted.definition,
    fingerprint: fingerprintOf(lifted, sha256Hex),
  });
  if (!parsed.success) return { ok: false, reason: firstIssueMessage(parsed.error) };
  return { ok: true, envelope: parsed.data, code: encodeTemplateCode(parsed.data) };
}
