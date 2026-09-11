/**
 * Request service routes tests
 *
 * Owner-only linking surface for Seerr. The store's public mapper stays real so
 * the "no key in the response" assertions mean something.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';
import type { AuthUser, RequestServiceProbeResult } from '@tracearr/shared';

vi.mock('../../db/client.js', () => ({ db: {} }));

vi.mock('../../db/pg.js', () => ({ isUniqueViolation: vi.fn(() => false) }));

vi.mock('../../services/requests/store.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/requests/store.js')>(
    '../../services/requests/store.js'
  );
  return {
    EMPTY_COUNTS: actual.EMPTY_COUNTS,
    toPublicRequestService: actual.toPublicRequestService,
    listRequestServices: vi.fn(),
    getRequestService: vi.fn(),
    createRequestService: vi.fn(),
    updateRequestService: vi.fn(),
    deleteRequestService: vi.fn(),
    readApiKey: vi.fn(),
    requestCountsByService: vi.fn(),
  };
});

vi.mock('../../services/requests/probe.js', async () => {
  const actual = await vi.importActual<typeof import('../../services/requests/probe.js')>(
    '../../services/requests/probe.js'
  );
  return { SeerrProbeError: actual.SeerrProbeError, probeSeerr: vi.fn() };
});

vi.mock('../../services/requests/serverLookup.js', () => ({ findServerById: vi.fn() }));

vi.mock('../../jobs/requestSyncQueue.js', () => ({
  enqueueRequestSync: vi.fn(),
  scheduleRequestSync: vi.fn(),
}));

import { isUniqueViolation } from '../../db/pg.js';
import { enqueueRequestSync, scheduleRequestSync } from '../../jobs/requestSyncQueue.js';
import { probeSeerr, SeerrProbeError } from '../../services/requests/probe.js';
import { findServerById } from '../../services/requests/serverLookup.js';
import {
  createRequestService,
  deleteRequestService,
  getRequestService,
  listRequestServices,
  readApiKey,
  requestCountsByService,
  updateRequestService,
  type RequestServiceRow,
} from '../../services/requests/store.js';
import { requestServiceRoutes } from '../requestServices.js';

const SERVICE_ID = '6d3a3f0e-9f4e-4a2a-8a1a-3b7a5c2d1e00';
const SERVER_ID = '0c1f1c5a-2b3d-4e5f-8a9b-0c1d2e3f4a5b';

function makeRow(overrides: Partial<RequestServiceRow> = {}): RequestServiceRow {
  return {
    id: SERVICE_ID,
    serverId: SERVER_ID,
    type: 'seerr',
    name: 'Overseerr',
    url: 'https://seerr.example.com',
    config: 'v1:ciphertext',
    configStatus: 'ok',
    enabled: true,
    remoteServerId: 'machine-1',
    version: '1.33.2',
    syncCursor: null,
    lastCounts: null,
    lastSyncAt: null,
    lastFullSyncAt: null,
    lastSyncError: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeProbe(overrides: Partial<RequestServiceProbeResult> = {}): RequestServiceProbeResult {
  return {
    applicationTitle: 'Overseerr',
    version: '1.33.2',
    mediaServerType: 'plex',
    remoteServerId: 'machine-1',
    matchedServerId: SERVER_ID,
    ...overrides,
  };
}

const ownerUser: AuthUser = {
  userId: randomUUID(),
  username: 'owner',
  role: 'owner',
  serverIds: [],
};

const adminUser: AuthUser = {
  userId: randomUUID(),
  username: 'admin',
  role: 'admin',
  serverIds: [],
};

async function buildTestApp(authUser: AuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  app.decorate('requireOwner', async (request: unknown, reply: FastifyReply) => {
    (request as { user: AuthUser }).user = authUser;
    if (authUser.role !== 'owner') {
      await reply.forbidden('Owner access required');
    }
  });

  await app.register(requestServiceRoutes, { prefix: '/request-services' });
  return app;
}

describe('Request Service Routes', () => {
  let app: FastifyInstance;

  beforeEach(() => {
    vi.mocked(requestCountsByService).mockResolvedValue(new Map());
    vi.mocked(findServerById).mockResolvedValue({
      id: SERVER_ID,
      name: 'Main Plex',
      machineIdentifier: 'machine-1',
    });
    vi.mocked(probeSeerr).mockResolvedValue(makeProbe());
    vi.mocked(enqueueRequestSync).mockResolvedValue('job-1');
    vi.mocked(scheduleRequestSync).mockResolvedValue(undefined);
    vi.mocked(readApiKey).mockReturnValue({ ok: true, apiKey: 'stored-key' });
  });

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe('GET /request-services', () => {
    it('returns the public shape with the request counts', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(listRequestServices).mockResolvedValue([makeRow()]);
      vi.mocked(requestCountsByService).mockResolvedValue(
        new Map([[SERVICE_ID, { requests: 12, unmatchedMedia: 2, unmatchedUsers: 1 }]])
      );

      const response = await app.inject({ method: 'GET', url: '/request-services' });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual([
        {
          id: SERVICE_ID,
          serverId: SERVER_ID,
          type: 'seerr',
          name: 'Overseerr',
          url: 'https://seerr.example.com',
          enabled: true,
          configStatus: 'ok',
          remoteServerId: 'machine-1',
          version: '1.33.2',
          lastSyncAt: null,
          lastFullSyncAt: null,
          lastSyncError: null,
          counts: { requests: 12, unmatchedMedia: 2, unmatchedUsers: 1 },
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      ]);
      expect(response.body).not.toContain('apiKey');
      expect(response.body).not.toContain('config"');
    });

    it('rejects a non-owner', async () => {
      app = await buildTestApp(adminUser);

      const response = await app.inject({ method: 'GET', url: '/request-services' });

      expect(response.statusCode).toBe(403);
      expect(listRequestServices).not.toHaveBeenCalled();
    });
  });

  describe('POST /request-services/test', () => {
    it('returns the probe result verbatim', async () => {
      app = await buildTestApp(ownerUser);

      const response = await app.inject({
        method: 'POST',
        url: '/request-services/test',
        payload: { url: 'https://seerr.example.com/', apiKey: 'secret' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(makeProbe());
      expect(probeSeerr).toHaveBeenCalledWith('https://seerr.example.com', 'secret');
      expect(response.body).not.toContain('secret');
    });

    it('502s a probe failure with its message', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(probeSeerr).mockRejectedValue(new SeerrProbeError('x'));

      const response = await app.inject({
        method: 'POST',
        url: '/request-services/test',
        payload: { url: 'https://seerr.example.com', apiKey: 'secret' },
      });

      expect(response.statusCode).toBe(502);
      expect(response.json()).toEqual({ error: 'x' });
    });
  });

  describe('POST /request-services', () => {
    const payload = {
      serverId: SERVER_ID,
      url: 'https://seerr.example.com',
      apiKey: 'secret',
    };

    it('409s when the probe reports a different media server', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(probeSeerr).mockResolvedValue(
        makeProbe({ remoteServerId: 'other-machine', matchedServerId: null })
      );

      const response = await app.inject({ method: 'POST', url: '/request-services', payload });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toContain('other-machine');
      expect(response.json().message).toContain('Main Plex');
      expect(createRequestService).not.toHaveBeenCalled();
    });

    it('409s when the server already has a service linked', async () => {
      app = await buildTestApp(ownerUser);
      const duplicate = Object.assign(new Error('duplicate key'), { code: '23505' });
      vi.mocked(createRequestService).mockRejectedValue(duplicate);
      vi.mocked(isUniqueViolation).mockReturnValue(true);

      const response = await app.inject({ method: 'POST', url: '/request-services', payload });

      expect(response.statusCode).toBe(409);
      expect(isUniqueViolation).toHaveBeenCalledWith(duplicate);
    });

    it('creates the link, schedules the jobs and returns 201 without the key', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(createRequestService).mockResolvedValue(makeRow());

      const response = await app.inject({ method: 'POST', url: '/request-services', payload });

      expect(response.statusCode).toBe(201);
      expect(createRequestService).toHaveBeenCalledWith({
        serverId: SERVER_ID,
        type: 'seerr',
        name: 'Overseerr',
        url: 'https://seerr.example.com',
        apiKey: 'secret',
        remoteServerId: 'machine-1',
        version: '1.33.2',
      });
      expect(scheduleRequestSync).toHaveBeenCalled();
      expect(enqueueRequestSync).toHaveBeenCalledWith(SERVICE_ID, 'full');
      const body = JSON.stringify(response.json());
      expect(body).not.toContain('apiKey');
      expect(body).not.toContain('"config"');
    });

    it('404s an unknown server', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(findServerById).mockResolvedValue(null);

      const response = await app.inject({ method: 'POST', url: '/request-services', payload });

      expect(response.statusCode).toBe(404);
      expect(probeSeerr).not.toHaveBeenCalled();
    });
  });

  describe('PATCH /request-services/:id', () => {
    it('disables without re-probing and reschedules', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getRequestService).mockResolvedValue(makeRow());
      vi.mocked(updateRequestService).mockResolvedValue(makeRow({ enabled: false }));

      const response = await app.inject({
        method: 'PATCH',
        url: `/request-services/${SERVICE_ID}`,
        payload: { enabled: false },
      });

      expect(response.statusCode).toBe(200);
      expect(updateRequestService).toHaveBeenCalledWith(SERVICE_ID, { enabled: false });
      expect(scheduleRequestSync).toHaveBeenCalled();
      expect(probeSeerr).not.toHaveBeenCalled();
      expect(JSON.stringify(response.json())).not.toContain('apiKey');
    });

    it('re-probes a url change and 409s a mismatch', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getRequestService).mockResolvedValue(makeRow());
      vi.mocked(probeSeerr).mockResolvedValue(
        makeProbe({ remoteServerId: 'other-machine', matchedServerId: null })
      );

      const response = await app.inject({
        method: 'PATCH',
        url: `/request-services/${SERVICE_ID}`,
        payload: { url: 'https://moved.example.com' },
      });

      expect(response.statusCode).toBe(409);
      expect(probeSeerr).toHaveBeenCalledWith('https://moved.example.com', 'stored-key');
      expect(updateRequestService).not.toHaveBeenCalled();
    });

    it('404s an unknown id', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getRequestService).mockResolvedValue(null);

      const response = await app.inject({
        method: 'PATCH',
        url: `/request-services/${SERVICE_ID}`,
        payload: { name: 'Renamed' },
      });

      expect(response.statusCode).toBe(404);
      expect(updateRequestService).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /request-services/:id', () => {
    it('returns 204 and reschedules', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(deleteRequestService).mockResolvedValue(true);

      const response = await app.inject({
        method: 'DELETE',
        url: `/request-services/${SERVICE_ID}`,
      });

      expect(response.statusCode).toBe(204);
      expect(scheduleRequestSync).toHaveBeenCalled();
    });

    it('404s an unknown id', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(deleteRequestService).mockResolvedValue(false);

      const response = await app.inject({
        method: 'DELETE',
        url: `/request-services/${SERVICE_ID}`,
      });

      expect(response.statusCode).toBe(404);
      expect(scheduleRequestSync).not.toHaveBeenCalled();
    });
  });

  describe('POST /request-services/:id/sync', () => {
    it('returns 202 with the job id', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getRequestService).mockResolvedValue(makeRow());

      const response = await app.inject({
        method: 'POST',
        url: `/request-services/${SERVICE_ID}/sync`,
      });

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual({ jobId: 'job-1' });
      expect(enqueueRequestSync).toHaveBeenCalledWith(SERVICE_ID, 'full');
    });

    it('409s while a sync is already running', async () => {
      app = await buildTestApp(ownerUser);
      vi.mocked(getRequestService).mockResolvedValue(makeRow());
      vi.mocked(enqueueRequestSync).mockRejectedValue(
        new Error('A sync is already in progress for this service')
      );

      const response = await app.inject({
        method: 'POST',
        url: `/request-services/${SERVICE_ID}/sync`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json().message).toBe('A sync is already in progress for this service');
    });
  });
});
