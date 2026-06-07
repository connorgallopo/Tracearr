/**
 * MCP endpoint tests.
 *
 * Verifies the Streamable HTTP MCP route: the JSON-RPC handshake-free stateless
 * behavior, tool listing, a tool call forwarding to the public API, auth
 * gating, and method restrictions. The backing public routes are stubbed so the
 * tests focus on the MCP adapter rather than database behavior.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import sensible from '@fastify/sensible';
import { API_BASE_PATH } from '@tracearr/shared';
import { mcpRoutes } from '../plugin.js';
import { TOOLS } from '../tools.js';

const VALID_AUTH = 'Bearer trr_pub_testtoken';

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number;
  result?: {
    tools?: { name: string }[];
    content?: { type: string; text: string }[];
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

async function buildTestApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  // Stub the owner-only public API auth: accept a known token, reject otherwise.
  app.decorate(
    'authenticatePublicApi',
    async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      if (request.headers.authorization !== VALID_AUTH) {
        return reply.unauthorized('Invalid API key');
      }
    }
  );

  // Stub the public routes the MCP tools forward to. These echo enough to prove
  // the request was routed and the bearer token forwarded.
  await app.register(
    async (pub) => {
      pub.get('/health', { preHandler: [pub.authenticatePublicApi] }, async () => ({
        status: 'ok',
        servers: [],
        forwardedAuth: VALID_AUTH,
      }));
      pub.get('/users', { preHandler: [pub.authenticatePublicApi] }, async (request) => {
        const query = request.query as { page?: string };
        return { data: [], meta: { total: 0, page: Number(query.page ?? 1), pageSize: 25 } };
      });
    },
    { prefix: `${API_BASE_PATH}/public` }
  );

  await app.register(mcpRoutes, { prefix: `${API_BASE_PATH}/mcp` });
  await app.ready();
  return app;
}

function postMcp(
  app: FastifyInstance,
  body: unknown,
  auth: string | undefined = VALID_AUTH
): Promise<JsonRpcResponse> {
  return app
    .inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mcp`,
      headers: auth ? { ...MCP_HEADERS, authorization: auth } : MCP_HEADERS,
      payload: body as Record<string, unknown>,
    })
    .then((res) => {
      expect(res.statusCode).toBe(200);
      return JSON.parse(res.body) as JsonRpcResponse;
    });
}

describe('MCP endpoint', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildTestApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('lists all registered tools', async () => {
    const result = await postMcp(app, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    const names = result.result?.tools?.map((t) => t.name) ?? [];
    expect(names).toHaveLength(TOOLS.length);
    expect(names).toContain('get_server_health');
    expect(names).toContain('query_violations');
  });

  it('calls a tool and forwards the result from the public API', async () => {
    const result = await postMcp(app, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'get_server_health', arguments: {} },
    });

    expect(result.result?.isError).toBeFalsy();
    const text = result.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { status: string; forwardedAuth: string };
    expect(payload.status).toBe('ok');
    // Confirms the caller's bearer token was forwarded to the public route.
    expect(payload.forwardedAuth).toBe(VALID_AUTH);
  });

  it('forwards arguments as query parameters', async () => {
    const result = await postMcp(app, {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'list_users', arguments: { page: 2 } },
    });

    const text = result.result?.content?.[0]?.text ?? '';
    const payload = JSON.parse(text) as { meta: { page: number } };
    expect(payload.meta.page).toBe(2);
  });

  it('returns an MCP error result for an unknown tool', async () => {
    const result = await postMcp(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'does_not_exist', arguments: {} },
    });

    // Unknown tools are rejected by the SDK as a JSON-RPC error.
    expect(result.error ?? result.result?.isError).toBeTruthy();
  });

  it('rejects requests without a valid API key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `${API_BASE_PATH}/mcp`,
      headers: MCP_HEADERS,
      payload: { jsonrpc: '2.0', id: 5, method: 'tools/list', params: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects GET with 405 Method Not Allowed', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `${API_BASE_PATH}/mcp`,
      headers: { authorization: VALID_AUTH },
    });
    expect(res.statusCode).toBe(405);
  });
});
