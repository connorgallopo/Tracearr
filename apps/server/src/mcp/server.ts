/**
 * Builds a per-request MCP server instance.
 *
 * The server is stateless: a fresh `Server` is created for each HTTP request so
 * that the caller's bearer token stays request-scoped and never leaks across
 * connections. Tool calls are forwarded to the existing Tracearr public API via
 * `app.inject()`, reusing its validation and authorization unchanged.
 */

import type { FastifyInstance } from 'fastify';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { API_BASE_PATH } from '@tracearr/shared';
import { getCurrentVersion } from '../utils/buildInfo.js';
import { TOOLS } from './tools.js';

const PUBLIC_API_PREFIX = `${API_BASE_PATH}/public`;

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError };
}

/**
 * Create a stateless MCP server for a single request.
 *
 * @param app Fastify instance used to dispatch internal requests.
 * @param authHeader The incoming `Authorization` header, forwarded to public
 *   routes so each tool call re-authenticates with the caller's API key.
 */
export function buildMcpServer(app: FastifyInstance, authHeader: string): McpServer {
  const server = new McpServer({ name: 'tracearr', version: getCurrentVersion() });

  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: true },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        // Forward all provided arguments as query-string values. The backing
        // public route validates and coerces them, so invalid input surfaces as
        // a 400 with a descriptive message rather than being dropped here.
        const query: Record<string, string> = {};
        for (const [key, value] of Object.entries(args)) {
          if (value === undefined || value === null) continue;
          query[key] = typeof value === 'string' ? value : String(value);
        }

        const response = await app.inject({
          method: tool.method,
          url: `${PUBLIC_API_PREFIX}${tool.path}`,
          headers: { authorization: authHeader },
          query,
        });

        if (response.statusCode >= 400) {
          let message = response.statusMessage || `HTTP ${response.statusCode}`;
          try {
            const body = response.json<{ message?: string; error?: string }>();
            message = body.message ?? body.error ?? message;
          } catch {
            // Non-JSON error body; fall back to the status message.
          }
          return textResult(`Request failed (${response.statusCode}): ${message}`, true);
        }

        return textResult(response.body);
      }
    );
  }

  return server;
}
