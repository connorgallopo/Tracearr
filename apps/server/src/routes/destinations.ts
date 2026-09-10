/**
 * Destination routes - notification targets (owner only)
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  DESTINATION_TYPES,
  createDestinationSchema,
  destinationConfigSchema,
  updateDestinationSchema,
  type DestinationKind,
  type DestinationTestResult,
} from '@tracearr/shared';
import { isUniqueViolation } from '../db/pg.js';
import { onDestinationChanged, onDestinationUnavailable } from '../jobs/newsletterQueue.js';
import {
  automationsReferencingDestinations,
  newslettersReferencingDestinations,
} from '../services/notifications/destinationRefs.js';
import {
  createDestination,
  deleteDestination,
  getDestination,
  listDestinations,
  readConfig,
  toPublicDestination,
  updateDestination,
  type DestinationRow,
} from '../services/notifications/destinationStore.js';
import {
  assertSafeSmtpHost,
  closeTransporter,
} from '../services/notifications/destinations/emailTransport.js';
import { getDestinationType } from '../services/notifications/destinations/registry.js';
import { assertSafeProbeUrl } from '../utils/ssrf.js';
import { firstIssueMessage } from '../utils/zod.js';

const DELIVER_TEST_TIMEOUT_MS = 10_000;
const REENCRYPT_MESSAGE = "Re-enter this destination's secret first";

/** Throws with the field name so the 400 says which url was blocked. */
function assertSafeUrls(kind: DestinationKind, config: Record<string, unknown>): void {
  if (kind === 'email') {
    const host = config['host'];
    const port = config['port'];
    if (typeof host === 'string' && typeof port === 'string') {
      try {
        assertSafeSmtpHost(host, port);
      } catch (error) {
        throw new Error(`host: ${error instanceof Error ? error.message : 'blocked host'}`, {
          cause: error,
        });
      }
    }
  }
  for (const field of DESTINATION_TYPES[kind].fields) {
    if (field.input !== 'url') continue;
    const value = config[field.key];
    if (typeof value !== 'string') continue;
    try {
      assertSafeProbeUrl(value);
    } catch (error) {
      throw new Error(`${field.key}: ${error instanceof Error ? error.message : 'blocked url'}`, {
        cause: error,
      });
    }
  }
}

const unsavedTestSchema = z.strictObject({
  type: createDestinationSchema.shape.type,
  config: z.record(z.string(), z.unknown()),
});

export async function destinationRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: [app.requireOwner] };

  async function runTest(
    kind: DestinationKind,
    name: string,
    config: Record<string, unknown>,
    reply: FastifyReply
  ): Promise<DestinationTestResult | FastifyReply> {
    try {
      const type = getDestinationType(kind);
      const report = await type.test(config, {
        destination: { id: 'test', name },
        signal: AbortSignal.timeout(type.deliverTimeoutMs ?? DELIVER_TEST_TIMEOUT_MS),
      });
      return report?.sentTo ? { success: true, sentTo: report.sentTo } : { success: true };
    } catch (error) {
      const message = (error instanceof Error ? error.message : 'Test failed').slice(0, 500);
      return reply.code(502).send({ success: false, error: message });
    }
  }

  /**
   * GET /destinations - List destinations with masked config
   */
  app.get('/', owner, async () => {
    const [rows, automationRefs, newsletterRefs] = await Promise.all([
      listDestinations(),
      automationsReferencingDestinations(),
      newslettersReferencingDestinations(),
    ]);
    return rows.map((row) =>
      toPublicDestination(
        row,
        automationRefs.get(row.id)?.length ?? 0,
        newsletterRefs.get(row.id)?.length ?? 0
      )
    );
  });

  /**
   * POST /destinations - Create a destination
   */
  app.post('/', owner, async (request, reply) => {
    const parsed = createDestinationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    }
    const config = destinationConfigSchema(parsed.data.type).safeParse(parsed.data.config);
    if (!config.success) {
      return reply.badRequest(`Invalid config: ${firstIssueMessage(config.error)}`);
    }
    try {
      assertSafeUrls(parsed.data.type, config.data);
    } catch (error) {
      return reply.badRequest(error instanceof Error ? error.message : 'blocked url');
    }

    let row: DestinationRow;
    try {
      row = await createDestination({ ...parsed.data, config: config.data });
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.conflict(`A destination named "${parsed.data.name}" already exists`);
      }
      throw error;
    }
    return reply.code(201).send(toPublicDestination(row, 0, 0));
  });

  /**
   * PATCH /destinations/:id - Update name, events, enabled, or config
   */
  app.patch<{ Params: { id: string } }>('/:id', owner, async (request, reply) => {
    const parsed = updateDestinationSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    }
    const current = await getDestination(request.params.id);
    if (!current) return reply.notFound('Destination not found');
    if (current.builtin && parsed.data.config !== undefined) {
      return reply.badRequest('Built-in destinations have no config');
    }
    if (parsed.data.config !== undefined) {
      // A row that failed to decrypt has no base to merge onto, so the patch must carry every required key.
      const opened = readConfig(current);
      const merged: Record<string, unknown> = { ...(opened.ok ? opened.config : {}) };
      for (const [key, value] of Object.entries(parsed.data.config)) {
        if (value === null) Reflect.deleteProperty(merged, key);
        else merged[key] = value;
      }
      const check = destinationConfigSchema(current.type).safeParse(merged);
      if (!check.success) {
        return reply.badRequest(`Invalid config: ${firstIssueMessage(check.error)}`);
      }
      try {
        assertSafeUrls(current.type, check.data);
      } catch (error) {
        return reply.badRequest(error instanceof Error ? error.message : 'blocked url');
      }
    }

    let row: DestinationRow;
    try {
      row = await updateDestination(current.id, parsed.data);
    } catch (error) {
      if (isUniqueViolation(error)) {
        const name = parsed.data.name ?? current.name;
        return reply.conflict(`A destination named "${name}" already exists`);
      }
      throw error;
    }
    await onDestinationChanged(row.id);
    const [automationRefs, newsletterRefs] = await Promise.all([
      automationsReferencingDestinations(),
      newslettersReferencingDestinations(),
    ]);
    return toPublicDestination(
      row,
      automationRefs.get(row.id)?.length ?? 0,
      newsletterRefs.get(row.id)?.length ?? 0
    );
  });

  /**
   * DELETE /destinations/:id - Remove a destination no automation or newsletter references
   */
  app.delete<{ Params: { id: string } }>('/:id', owner, async (request, reply) => {
    const current = await getDestination(request.params.id);
    if (!current) return reply.notFound('Destination not found');
    if (current.builtin) return reply.badRequest('Built-in destinations cannot be deleted');

    const refs = (await automationsReferencingDestinations()).get(current.id) ?? [];
    if (refs.length > 0) {
      return reply.code(409).send({
        message: `Used by ${refs.length} rule(s)`,
        rules: refs.map((ref) => ref.ruleName),
      });
    }

    const newsletterNames = (await newslettersReferencingDestinations()).get(current.id) ?? [];
    if (newsletterNames.length > 0) {
      return reply.code(409).send({
        message: `Used by ${newsletterNames.length} newsletter(s)`,
        newsletters: newsletterNames,
      });
    }

    await deleteDestination(current.id);
    closeTransporter(current.id);
    await onDestinationUnavailable(current.id);
    return reply.code(204).send();
  });

  /**
   * POST /destinations/:id/test - Deliver a test notification to a saved destination
   */
  app.post<{ Params: { id: string } }>('/:id/test', owner, async (request, reply) => {
    const current = await getDestination(request.params.id);
    if (!current) return reply.notFound('Destination not found');
    if (current.builtin) return reply.badRequest('Built-in destinations cannot be tested');
    if (current.configStatus !== 'ok') {
      return reply.code(409).send({ message: REENCRYPT_MESSAGE });
    }
    const opened = readConfig(current);
    if (!opened.ok) {
      return reply.code(409).send({ message: REENCRYPT_MESSAGE });
    }
    return runTest(current.type, current.name, opened.config, reply);
  });

  /**
   * POST /destinations/test - Deliver a test notification to an unsaved config
   */
  app.post('/test', owner, async (request, reply) => {
    const parsed = unsavedTestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    }
    const config = destinationConfigSchema(parsed.data.type).safeParse(parsed.data.config);
    if (!config.success) {
      return reply.badRequest(`Invalid config: ${firstIssueMessage(config.error)}`);
    }
    try {
      assertSafeUrls(parsed.data.type, config.data);
    } catch (error) {
      return reply.badRequest(error instanceof Error ? error.message : 'blocked url');
    }
    return runTest(parsed.data.type, 'test', config.data, reply);
  });
}
