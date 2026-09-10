/**
 * Template routes - the catalog behind the gallery, the import flow and the
 * binding form. Reads are open to any authenticated caller; writes are owner only.
 */

import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  ShareCodeError,
  assertShareDepth,
  createAutomationSchema,
  fingerprintOf,
  templateEnvelopeSchema,
  uuidSchema,
  type ShareCodeReason,
  type TemplateEnvelope,
} from '@tracearr/shared';
import { db } from '../db/client.js';
import { scheduleInactivityChecks } from '../jobs/inactivityCheckQueue.js';
import { invalidateAutomationsCache } from '../jobs/poller/database.js';
import {
  loadAutomation,
  missingScopeRef,
  needsInactivitySweep,
  toAutomation,
} from '../services/automations/read.js';
import {
  defaultInstanceName,
  materializeInstance,
} from '../services/automations/templates/materialize.js';
import { decodeTemplateCode } from '../services/automations/templates/shareCode.js';
import {
  createTemplate,
  deleteTemplate,
  getTemplate,
  getTemplateVersion,
  instantiateTemplate,
  listTemplates,
  matchTemplate,
  sha256Hex,
} from '../services/automations/templates/store.js';
import { unknownDestinationIds } from '../services/notifications/destinationRefs.js';
import { getCurrentVersion } from '../utils/buildInfo.js';
import { compareVersions, getBaseVersion } from '../jobs/versionCheckQueue.js';
import { firstIssueMessage } from '../utils/zod.js';

const idParamSchema = z.object({ id: uuidSchema });

const versionParamsSchema = z.object({
  id: uuidSchema,
  version: z.coerce.number().int().min(1).max(2_147_483_647),
});

// Room above the decoder's own 64 KiB cap, so an over-long code comes back as `too_long`
// with its reason instead of a bare length error the web cannot name.
const MAX_CODE_CHARS = 70_000;

const importBodySchema = z.object({
  code: z.string().min(1).max(MAX_CODE_CHARS).optional(),
  envelope: z.unknown().optional(),
  // The envelope never says where it came from: an import is the default, and only the
  // export dialog's "save as a template" claims `local`.
  source: z.literal('local').optional(),
  replace: uuidSchema.optional(),
});

const instantiateBodySchema = z.object({
  inputs: z.record(z.string(), z.unknown()).default({}),
  name: createAutomationSchema.shape.name.optional(),
  isActive: createAutomationSchema.shape.isActive,
  severity: createAutomationSchema.shape.severity.optional(),
  cooldownMinutes: createAutomationSchema.shape.cooldownMinutes,
  retentionDays: createAutomationSchema.shape.retentionDays,
});

interface MinServerVersion {
  required: string;
  current: string;
  satisfied: boolean;
}

/** A build with no version stamped into it is a dev build, and runs anything. */
function minServerVersionState(required: string): MinServerVersion {
  const current = getCurrentVersion();
  const release = getBaseVersion(current);
  return {
    required,
    current,
    satisfied: release === '0.0.0' || compareVersions(release, getBaseVersion(required)) >= 0,
  };
}

// The reason travels with the message so the web can branch without reading English.
const SHARE_CODE_MESSAGES: Record<ShareCodeReason, string> = {
  prefix: 'This is not a Tracearr share code',
  too_long: 'This share code is too long',
  incomplete: 'This share code looks cut off',
  too_deep: 'This share code is nested too deeply',
  invalid_json: 'This share code does not carry valid JSON',
};

type EnvelopeResult =
  | { ok: true; envelope: TemplateEnvelope }
  | { ok: false; message: string; reason?: ShareCodeReason };

const rejectEnvelope = (reply: FastifyReply, read: { message: string; reason?: ShareCodeReason }) =>
  reply.code(400).send({
    statusCode: 400,
    error: 'Bad Request',
    message: read.message,
    ...(read.reason === undefined ? {} : { reason: read.reason }),
  });

/** A share code and a pasted envelope are the same payload once the code is unwrapped. */
function readEnvelope(body: { code?: string; envelope?: unknown }): EnvelopeResult {
  let payload: unknown;
  try {
    if (body.code !== undefined) {
      payload = decodeTemplateCode(body.code);
    } else if (body.envelope !== undefined) {
      // Pasted JSON never went through the decoder, so the nesting cap is applied here.
      assertShareDepth(body.envelope);
      payload = body.envelope;
    } else {
      return { ok: false, message: 'A share code or an envelope is required' };
    }
  } catch (error) {
    if (error instanceof ShareCodeError) {
      return { ok: false, message: SHARE_CODE_MESSAGES[error.reason], reason: error.reason };
    }
    throw error;
  }

  const parsed = templateEnvelopeSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, message: `Invalid template: ${firstIssueMessage(parsed.error)}` };
  }
  if (fingerprintOf(parsed.data, sha256Hex) !== parsed.data.fingerprint) {
    return { ok: false, message: 'Invalid template: the fingerprint does not match the body' };
  }
  return { ok: true, envelope: parsed.data };
}

export const templateRoutes: FastifyPluginAsync = async (app) => {
  const owner = { preHandler: [app.requireOwner] };
  const authed = { preHandler: [app.authenticate] };
  // Decoding a pasted code costs real work, so the two routes that do it are capped.
  const decoding = { ...owner, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

  /**
   * GET /templates - Every stored template with the number of automations on it
   */
  app.get('/', authed, async () => ({ data: await listTemplates() }));

  /**
   * GET /templates/:id - One template with its current version
   */
  app.get('/:id', authed, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid template ID');

    const template = await getTemplate(params.data.id);
    if (!template) return reply.notFound('Template not found');
    return template;
  });

  /**
   * GET /templates/:id/versions/:version - One stored version, however old
   */
  app.get('/:id/versions/:version', authed, async (request, reply) => {
    const params = versionParamsSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid template version');

    const version = await getTemplateVersion(params.data.id, params.data.version);
    if (!version) return reply.notFound('Template version not found');
    return version;
  });

  /**
   * POST /templates/preview - What an import would land on, without writing anything
   */
  app.post('/preview', decoding, async (request, reply) => {
    const body = importBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(body.error)}`);
    }

    const read = readEnvelope(body.data);
    if (!read.ok) return rejectEnvelope(reply, read);

    const existing = await matchTemplate(read.envelope);
    return {
      envelope: read.envelope,
      fingerprint: read.envelope.fingerprint,
      ...(existing === null ? {} : { existing }),
      minServerVersion: minServerVersionState(read.envelope.minServerVersion),
    };
  });

  /**
   * POST /templates - Store an imported or locally saved template
   */
  app.post('/', decoding, async (request, reply) => {
    const body = importBodySchema.safeParse(request.body);
    if (!body.success) {
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(body.error)}`);
    }

    const read = readEnvelope(body.data);
    if (!read.ok) return rejectEnvelope(reply, read);

    const support = minServerVersionState(read.envelope.minServerVersion);
    if (!support.satisfied) {
      return reply.code(422).send({
        statusCode: 422,
        error: 'Unprocessable Entity',
        message: `This template needs Tracearr ${support.required}; this server runs ${support.current}`,
        minServerVersion: support,
      });
    }

    const stored = await createTemplate(read.envelope, {
      source: body.data.source ?? 'import',
      ...(body.data.replace === undefined ? {} : { replaceId: body.data.replace }),
    });
    const template = await getTemplate(stored.id);
    if (!template) return reply.internalServerError('Failed to store template');
    return reply.code(stored.created ? 201 : 200).send(template);
  });

  /**
   * DELETE /templates/:id - Remove a template no automation is bound to
   */
  app.delete('/:id', owner, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid template ID');

    const outcome = await deleteTemplate(params.data.id);
    if (outcome === 'builtin') return reply.forbidden('Built-in templates cannot be deleted');
    if (outcome !== 'deleted') {
      return reply.code(409).send({
        message: `Used by ${outcome.usedBy} automation(s)`,
        usedBy: outcome.usedBy,
        names: outcome.names,
      });
    }
    return reply.code(204).send();
  });

  /**
   * POST /templates/:id/instantiate - Bind a template's inputs into an automation
   */
  app.post('/:id/instantiate', owner, async (request, reply) => {
    const params = idParamSchema.safeParse(request.params);
    if (!params.success) return reply.badRequest('Invalid template ID');
    const body = instantiateBodySchema.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(body.error)}`);
    }

    const template = await getTemplate(params.data.id);
    if (!template) return reply.notFound('Template not found');

    // The refs are checked against the definition the bindings produce, not the
    // bindings themselves, so the same checks a builder save runs apply here.
    const { inputs, name, ...overrides } = body.data;
    const materialized = materializeInstance(
      template.version,
      inputs,
      name ?? (await defaultInstanceName(db, template.name, template.version, inputs))
    );
    if (!materialized.ok) return reply.badRequest(materialized.reason);

    const missingScope = await missingScopeRef(materialized.definition);
    if (missingScope) return reply.notFound(missingScope);

    const missingDestinations = await unknownDestinationIds(materialized.definition.actions);
    if (missingDestinations.length > 0) {
      return reply.badRequest(`Unknown destination id(s): ${missingDestinations.join(', ')}`);
    }

    // A pasted template arrives unreviewed, so a caller that says nothing gets it paused.
    const paused = overrides.isActive === undefined && template.source === 'import';
    const created = await db.transaction((tx) =>
      instantiateTemplate(
        tx,
        template,
        { definition: materialized.definition, inputs },
        paused ? { ...overrides, isActive: false } : overrides
      )
    );

    invalidateAutomationsCache();
    if (needsInactivitySweep(created)) void scheduleInactivityChecks();

    const detail = await loadAutomation(created.id, request.user);
    return reply.code(201).send(toAutomation(detail ?? created));
  });
};
