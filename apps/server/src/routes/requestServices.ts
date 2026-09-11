import {
  createRequestServiceSchema,
  testRequestServiceSchema,
  updateRequestServiceSchema,
  type RequestServiceProbeResult,
} from '@tracearr/shared';
import { isUniqueViolation } from '../db/pg.js';
import {
  enqueueRequestSync,
  isRequestSyncActive,
  scheduleRequestSync,
} from '../jobs/requestSyncQueue.js';
import { probeSeerr, SeerrProbeError } from '../services/requests/probe.js';
import { SeerrApiError } from '../services/requests/seerrClient.js';
import { findServerById } from '../services/requests/serverLookup.js';
import {
  createRequestService,
  deleteRequestService,
  EMPTY_COUNTS,
  getRequestService,
  listRequestServices,
  readApiKey,
  requestCountsByService,
  toPublicRequestService,
  updateRequestService,
} from '../services/requests/store.js';
import { firstIssueMessage } from '../utils/zod.js';
import type { FastifyInstance, FastifyReply } from 'fastify';

async function probeOr502(
  url: string,
  apiKey: string,
  reply: FastifyReply
): Promise<RequestServiceProbeResult | FastifyReply> {
  try {
    return await probeSeerr(url, apiKey);
  } catch (error) {
    if (error instanceof SeerrProbeError || error instanceof SeerrApiError) {
      return reply.code(502).send({ error: error.message });
    }
    if (error instanceof Error && /blocked|link-local|scheme/i.test(error.message)) {
      return reply.badRequest(error.message);
    }
    throw error;
  }
}

function mismatch(
  reply: FastifyReply,
  probe: RequestServiceProbeResult,
  server: { name: string; machineIdentifier: string | null }
): FastifyReply {
  return reply.code(409).send({
    message: `This Seerr is connected to a different server (Seerr reports ${probe.remoteServerId}, ${server.name} is ${server.machineIdentifier ?? 'unknown'})`,
    remoteServerId: probe.remoteServerId,
    matchedServerId: probe.matchedServerId,
  });
}

export async function requestServiceRoutes(app: FastifyInstance): Promise<void> {
  const owner = { preHandler: [app.requireOwner] };

  app.get('/', owner, async () => {
    const [rows, counts] = await Promise.all([listRequestServices(), requestCountsByService()]);
    return rows.map((row) => toPublicRequestService(row, counts.get(row.id) ?? EMPTY_COUNTS));
  });

  app.post('/test', owner, async (request, reply) => {
    const parsed = testRequestServiceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    }
    return probeOr502(parsed.data.url, parsed.data.apiKey, reply);
  });

  app.post('/', owner, async (request, reply) => {
    const parsed = createRequestServiceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    }
    const server = await findServerById(parsed.data.serverId);
    if (!server) return reply.notFound('Server not found');

    const probe = await probeOr502(parsed.data.url, parsed.data.apiKey, reply);
    if (!('remoteServerId' in probe)) return probe;
    if (probe.remoteServerId !== server.machineIdentifier) return mismatch(reply, probe, server);

    try {
      const row = await createRequestService({
        serverId: server.id,
        type: 'seerr',
        name: parsed.data.name ?? probe.applicationTitle,
        url: parsed.data.url,
        apiKey: parsed.data.apiKey,
        remoteServerId: probe.remoteServerId,
        version: probe.version,
      });
      await scheduleRequestSync();
      await enqueueRequestSync(row.id, 'full');
      return reply.code(201).send(toPublicRequestService(row, EMPTY_COUNTS));
    } catch (error) {
      if (isUniqueViolation(error)) {
        return reply.conflict('This server already has a request service linked');
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>('/:id', owner, async (request, reply) => {
    const parsed = updateRequestServiceSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.badRequest(`Invalid request body: ${firstIssueMessage(parsed.error)}`);
    }
    const current = await getRequestService(request.params.id);
    if (!current) return reply.notFound('Request service not found');

    let probe: RequestServiceProbeResult | null = null;
    if (parsed.data.url !== undefined || parsed.data.apiKey !== undefined) {
      const stored = readApiKey(current);
      const apiKey = parsed.data.apiKey ?? (stored.ok ? stored.apiKey : null);
      if (!apiKey) return reply.badRequest('Enter the API key again to change the URL');
      const result = await probeOr502(parsed.data.url ?? current.url, apiKey, reply);
      if (!('remoteServerId' in result)) return result;
      const server = await findServerById(current.serverId);
      if (!server) return reply.notFound('Server not found');
      if (result.remoteServerId !== server.machineIdentifier)
        return mismatch(reply, result, server);
      probe = result;
    }

    const row = await updateRequestService(current.id, {
      ...parsed.data,
      ...(probe ? { remoteServerId: probe.remoteServerId, version: probe.version } : {}),
    });
    if (!row) return reply.notFound('Request service not found');
    if (parsed.data.enabled !== undefined) await scheduleRequestSync();
    const counts = (await requestCountsByService()).get(row.id) ?? EMPTY_COUNTS;
    return toPublicRequestService(row, counts);
  });

  app.delete<{ Params: { id: string } }>('/:id', owner, async (request, reply) => {
    const deleted = await deleteRequestService(request.params.id);
    if (!deleted) return reply.notFound('Request service not found');
    await scheduleRequestSync();
    return reply.code(204).send();
  });

  app.post<{ Params: { id: string } }>('/:id/sync', owner, async (request, reply) => {
    const current = await getRequestService(request.params.id);
    if (!current) return reply.notFound('Request service not found');
    if (await isRequestSyncActive(current.id)) {
      return reply.conflict('A sync is already in progress for this service');
    }
    const jobId = await enqueueRequestSync(current.id, 'full');
    return reply.code(202).send({ jobId });
  });
}
