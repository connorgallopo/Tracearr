/**
 * Fastify plugin exposing a Model Context Protocol (MCP) endpoint.
 *
 * Mounted at `${API_BASE_PATH}/mcp` and gated behind the `MCP_ENABLED` flag
 * (the plugin is only registered when enabled). Transport is Streamable HTTP in
 * stateless mode: each POST creates a fresh server + transport, authenticated
 * with the same owner-scoped `trr_pub_*` API keys as the public REST API.
 *
 * Phase 1 is read-only; the underlying tools only call read endpoints.
 */

import type { FastifyPluginAsync } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './server.js';

export const mcpRoutes: FastifyPluginAsync = async (app) => {
  // Tighter rate limit than the global default for this AI-facing surface:
  // agents can loop and fire many tool calls in quick succession.
  const routeConfig = {
    preHandler: [app.authenticatePublicApi],
    config: {
      rateLimit: {
        max: 120,
        timeWindow: '1 minute',
      },
    },
  };

  app.post('/', routeConfig, async (request, reply) => {
    const authHeader = request.headers.authorization ?? '';
    const server = buildMcpServer(app, authHeader);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no session tracking
      enableJsonResponse: true, // single JSON response instead of an SSE stream
    });

    reply.raw.on('close', () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      // Take over the raw response; the transport writes the MCP reply directly.
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (err) {
      app.log.error({ err }, 'MCP request handling failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'Internal server error' },
            id: null,
          })
        );
      }
    }
  });

  // Stateless mode does not support server-initiated streams or session
  // teardown, so GET (SSE) and DELETE are not allowed.
  app.get('/', { preHandler: [app.authenticatePublicApi] }, async (_request, reply) =>
    reply.code(405).send({ error: 'Method Not Allowed', message: 'Use POST for MCP requests.' })
  );
  app.delete('/', { preHandler: [app.authenticatePublicApi] }, async (_request, reply) =>
    reply.code(405).send({ error: 'Method Not Allowed', message: 'Use POST for MCP requests.' })
  );
};
