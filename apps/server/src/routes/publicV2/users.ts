/**
 * Public API v2 - GET /users and sub-resources
 *
 * Lists Tracearr identities (users), not per-server accounts. Each identity
 * carries a correlation block whose accounts expose external_user_id, the media
 * server's own user identifier that integrators correlate on.
 */

import { booleanStringSchema } from '@tracearr/shared';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../../db/client.js';
import { decodeCursor, encodeCursor } from '../../utils/cursor.js';
import { representativeAccountOrderSql } from '../../utils/representativeAccount.js';
import {
  cursorPage,
  cursorPaginationSchema,
  idList,
  runHistoryPage,
  STATS_WINDOWS,
  windowDayFilter,
  type RouteConfig,
  type StatsWindowKey,
} from './shared.js';

interface IdentityRow {
  id: string;
  username: string;
  identity_name: string | null;
  email: string | null;
  plex_account_id: string | null;
  created_at: Date;
}

interface AccountRow {
  user_id: string;
  server_id: string;
  server_type: string;
  server_user_id: string;
  external_user_id: string;
  username: string;
  removed_at: Date | null;
}

interface AccountBlock {
  server_id: string;
  server_type: string;
  server_user_id: string;
  external_user_id: string;
  username: string;
  removed_at: string | null;
}

async function fetchAccountsByUserId(userIds: string[]): Promise<Map<string, AccountBlock[]>> {
  const byUser = new Map<string, AccountBlock[]>();
  if (userIds.length === 0) return byUser;

  const result = await db.execute(sql`
    SELECT
      su.user_id,
      su.server_id,
      sv.type AS server_type,
      su.id AS server_user_id,
      su.external_id AS external_user_id,
      su.username,
      su.removed_at
    FROM server_users su
    JOIN servers sv ON sv.id = su.server_id
    WHERE su.user_id IN (${idList(userIds)})
    ORDER BY su.user_id, su.id
  `);

  for (const row of result.rows as unknown as AccountRow[]) {
    const block: AccountBlock = {
      server_id: row.server_id,
      server_type: row.server_type,
      server_user_id: row.server_user_id,
      external_user_id: row.external_user_id,
      username: row.username,
      removed_at: row.removed_at ? new Date(row.removed_at).toISOString() : null,
    };
    const existing = byUser.get(row.user_id);
    if (existing) existing.push(block);
    else byUser.set(row.user_id, [block]);
  }

  return byUser;
}

function correlationBlock(identity: IdentityRow, accounts: AccountBlock[]) {
  return {
    id: identity.id,
    username: identity.username,
    identity_name: identity.identity_name,
    email: identity.email,
    plex_account_id: identity.plex_account_id,
    accounts,
  };
}

async function findIdentity(id: string): Promise<IdentityRow | null> {
  const result = await db.execute(sql`
    SELECT id, username, name AS identity_name, email, plex_account_id, created_at
    FROM users
    WHERE id = ${id}::uuid
  `);
  const row = (result.rows as unknown as IdentityRow[])[0];
  return row ?? null;
}

async function identityServerUserIds(id: string): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT id FROM server_users WHERE user_id = ${id}::uuid
  `);
  return (result.rows as unknown as { id: string }[]).map((r) => r.id);
}

export function registerUsersRoutes(app: FastifyInstance, routeConfig: RouteConfig): void {
  /**
   * GET /users - Cursor-paginated identities with account correlation
   *
   * One entry per Tracearr identity. serverUsers rows collapse to a single
   * representative account with the same preference order as the internal
   * roster; include_removed keeps identities whose every account is removed.
   */
  app.get(
    '/users',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const querySchema = cursorPaginationSchema.extend({
        include_removed: booleanStringSchema.default(false),
      });
      const query = querySchema.safeParse(request.query);
      if (!query.success) {
        return reply.badRequest('Invalid query parameters');
      }
      const { cursor, pageSize, include_removed: includeRemoved } = query.data;

      let cursorValue: { startedAt: Date; id: string } | null = null;
      if (cursor) {
        cursorValue = decodeCursor(cursor);
        if (!cursorValue || !z.uuid().safeParse(cursorValue.id).success) {
          return reply.badRequest('Invalid cursor');
        }
      }

      const removedFilter = includeRemoved ? sql`` : sql` AND rep.removed_at IS NULL`;
      // Cursor is ms-grain but created_at is µs; compare and order at ms or boundary rows skip
      const cursorFilter = cursorValue
        ? sql` AND (date_trunc('milliseconds', u.created_at), u.id) < (${cursorValue.startedAt}::timestamptz, ${cursorValue.id}::uuid)`
        : sql``;

      const result = await db.execute(sql`
        WITH rep AS (
          SELECT DISTINCT ON (su.user_id) su.user_id, su.removed_at
          FROM server_users su
          INNER JOIN users u ON su.user_id = u.id
          ORDER BY su.user_id, ${representativeAccountOrderSql('su')}
        )
        SELECT u.id, u.username, u.name AS identity_name, u.email, u.plex_account_id, u.created_at
        FROM users u
        JOIN rep ON rep.user_id = u.id
        WHERE true${removedFilter}${cursorFilter}
        ORDER BY date_trunc('milliseconds', u.created_at) DESC, u.id DESC
        LIMIT ${pageSize}
      `);

      const identities = result.rows as unknown as IdentityRow[];
      const accountsByUser = await fetchAccountsByUserId(identities.map((i) => i.id));
      const data = identities.map((identity) =>
        correlationBlock(identity, accountsByUser.get(identity.id) ?? [])
      );

      const lastRow =
        identities.length === pageSize ? identities[identities.length - 1] : undefined;
      const nextCursor = lastRow ? encodeCursor(new Date(lastRow.created_at), lastRow.id) : null;
      return cursorPage(data, nextCursor, pageSize);
    }
  );

  /**
   * GET /users/:id - One identity with its account correlation block
   */
  app.get(
    '/users/:id',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const params = z.object({ id: z.uuid() }).safeParse(request.params);
      if (!params.success) return reply.badRequest('Invalid user id');
      const { id } = params.data;

      const identity = await findIdentity(id);
      if (!identity) return reply.notFound();

      const accountsByUser = await fetchAccountsByUserId([id]);
      return correlationBlock(identity, accountsByUser.get(id) ?? []);
    }
  );

  /**
   * GET /users/:id/stats - Plays, watch time, and top genres for an identity
   *
   * Summed from user_media_plays_daily over every account the identity owns,
   * across all_time/last_30/last_7 UTC-day windows.
   */
  app.get(
    '/users/:id/stats',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const params = z.object({ id: z.uuid() }).safeParse(request.params);
      if (!params.success) return reply.badRequest('Invalid user id');
      const { id } = params.data;

      const identity = await findIdentity(id);
      if (!identity) return reply.notFound();

      const serverUserIds = await identityServerUserIds(id);
      const windows = {} as Record<StatsWindowKey, { plays: number; watch_time_ms: number }>;

      if (serverUserIds.length === 0) {
        for (const win of STATS_WINDOWS) windows[win.key] = { plays: 0, watch_time_ms: 0 };
        return { user_id: id, windows, top_genres: [] };
      }

      const scope = sql`p.server_user_id IN (${idList(serverUserIds)})`;

      for (const win of STATS_WINDOWS) {
        const result = await db.execute(sql`
          SELECT
            COUNT(DISTINCT p.chain_id) FILTER (WHERE p.counted) AS plays,
            COALESCE(SUM(p.watched_ms), 0) AS watch_time_ms
          FROM user_media_plays_daily p
          WHERE ${scope}${windowDayFilter(sql`p.day`, win.days)}
        `);
        const row = result.rows[0] as { plays: string | number; watch_time_ms: string | number };
        windows[win.key] = {
          plays: Number(row?.plays ?? 0),
          watch_time_ms: Number(row?.watch_time_ms ?? 0),
        };
      }

      const genreResult = await db.execute(sql`
        SELECT g AS genre, COUNT(DISTINCT p.chain_id) FILTER (WHERE p.counted)::int AS plays
        FROM user_media_plays_daily p
        JOIN media m ON m.id = p.media_id
        CROSS JOIN LATERAL unnest(m.genres) AS g
        WHERE ${scope}
        GROUP BY g
        ORDER BY plays DESC, lower(g) ASC
        LIMIT 10
      `);
      const topGenres = (genreResult.rows as unknown as { genre: string; plays: number }[]).map(
        (r) => ({ genre: r.genre, plays: Number(r.plays) })
      );

      return { user_id: id, windows, top_genres: topGenres };
    }
  );

  /**
   * GET /users/:id/history - Watch history for an identity as plays
   *
   * Same chain-grain paging as /history, scoped to every account the identity
   * owns.
   */
  app.get(
    '/users/:id/history',
    { preHandler: [app.authenticatePublicApi], config: routeConfig },
    async (request, reply) => {
      const params = z.object({ id: z.uuid() }).safeParse(request.params);
      if (!params.success) return reply.badRequest('Invalid user id');
      const { id } = params.data;

      const query = cursorPaginationSchema.safeParse(request.query);
      if (!query.success) return reply.badRequest('Invalid query parameters');
      const { cursor, pageSize } = query.data;

      let cursorValue: { startedAt: Date; id: string } | null = null;
      if (cursor) {
        cursorValue = decodeCursor(cursor);
        if (!cursorValue || !z.uuid().safeParse(cursorValue.id).success) {
          return reply.badRequest('Invalid cursor');
        }
      }

      const identity = await findIdentity(id);
      if (!identity) return reply.notFound();

      const conditions = [
        sql`s.server_user_id IN (SELECT su.id FROM server_users su WHERE su.user_id = ${id}::uuid)`,
      ];
      const { data, nextCursor } = await runHistoryPage(
        conditions,
        pageSize,
        cursorValue,
        undefined
      );
      return cursorPage(data, nextCursor, pageSize);
    }
  );
}
