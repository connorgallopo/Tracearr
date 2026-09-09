/**
 * Public API v2 Routes - External access for third-party integrations
 *
 * All routes require Bearer token authentication via Authorization header.
 * Token format: Authorization: Bearer trr_pub_<base64url>
 *
 * v2 uses cursor pagination on list endpoints and keeps its own OpenAPI
 * document. Handlers live in sibling modules; this plugin wires the shared
 * per-route rate-limit config, the /docs endpoint, and each route group.
 */

import type { FastifyPluginAsync } from 'fastify';
import { db } from '../../db/client.js';
import { servers } from '../../db/schema.js';
import { generateOpenAPIDocumentV2 } from '../publicV2.openapi.js';
import { getPublicApiRateLimit } from './rateLimitCache.js';
import type { RouteConfig } from './shared.js';
import { registerHistoryRoutes } from './history.js';
import { registerLibrariesRoutes } from './libraries.js';
import { registerMediaRoutes } from './media.js';
import { registerStreamsRoutes } from './streams.js';
import { registerUsersRoutes } from './users.js';
import { registerWatchedMediaRoutes } from './watchedMedia.js';

export { cursorPage, cursorPaginationSchema, type CursorPage } from './shared.js';

export const publicV2Routes: FastifyPluginAsync = async (app) => {
  // One shared limiter; per-route config would multiply the per-token budget by route count.
  // max is resolved lazily per request (never at registration) so a DB-down boot can still
  // reach maintenance mode instead of failing plugin registration and crash-looping.
  const routeConfig: RouteConfig = { rateLimit: false };
  if (app.hasDecorator('rateLimit')) {
    app.addHook(
      'preHandler',
      app.rateLimit({ max: () => getPublicApiRateLimit(), timeWindow: '1 minute' })
    );
  }

  /**
   * GET /docs - OpenAPI 3.0 specification for v2
   */
  app.get(
    '/docs',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const spec = generateOpenAPIDocumentV2() as Record<string, unknown>;

      // Derive basePath from the pre-rewrite URL so Swagger UI's "Try it out"
      // sends requests to the correct prefixed path (e.g. /tracearr/api/v2/...)
      const originalPath = (request.originalUrl ?? request.url).split('?')[0]!;
      const basePath = originalPath.replace(/\/api\/v2\/public\/docs$/, '');
      if (basePath) {
        spec.servers = [{ url: basePath }];
      }

      const allServers = await db
        .select({ id: servers.id, name: servers.name })
        .from(servers)
        .orderBy(servers.displayOrder);

      if (allServers.length > 0) {
        const serverIds = allServers.map((s) => s.id);
        const serverListDescription =
          'Filter to specific server. Available servers:\n' +
          allServers.map((s) => `• **${s.name}**: \`${s.id}\``).join('\n');

        const paths = spec.paths as Record<string, Record<string, unknown>> | undefined;
        if (paths) {
          for (const pathObj of Object.values(paths)) {
            for (const methodObj of Object.values(pathObj)) {
              const method = methodObj as { parameters?: Array<Record<string, unknown>> };
              if (method.parameters) {
                for (const param of method.parameters) {
                  if (
                    (param.name === 'serverId' || param.name === 'server_id') &&
                    param.in === 'query'
                  ) {
                    const schema = param.schema as Record<string, unknown> | undefined;
                    if (schema) {
                      schema.enum = serverIds;
                    }
                    param.description = serverListDescription;
                  }
                }
              }
            }
          }
        }
      }

      return reply.type('application/json').send(spec);
    }
  );

  registerHistoryRoutes(app, routeConfig);
  registerStreamsRoutes(app, routeConfig);
  registerMediaRoutes(app, routeConfig);
  registerUsersRoutes(app, routeConfig);
  registerLibrariesRoutes(app, routeConfig);
  registerWatchedMediaRoutes(app, routeConfig);
};
