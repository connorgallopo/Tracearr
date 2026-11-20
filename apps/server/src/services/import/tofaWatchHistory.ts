/**
 * Reading tofa's own record of finished plays, for the history import and the profile backfill:
 * the server and its client, the history a page at a time, and the plays in Tracearr a page
 * records.
 */

import { SERVER_PROFILES } from '@tracearr/shared';
import { UnrecoverableError } from 'bullmq';
import { and, eq, gte, inArray, lte, or, type SQL } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { servers, sessions } from '../../db/schema.js';
import { ServerHistoricalError } from '../liveServers.js';
import { TofaClient } from '../mediaServer/tofa/client.js';
import type { TofaWatchHistoryRow } from '../mediaServer/tofa/types.js';

const PAGE_SIZE = 200;
// A play Tracearr captured starts within moments of tofa's record of it
export const CAPTURED_START_SLACK_MS = 24 * 60 * 60 * 1000;

/**
 * The plays in Tracearr that history rows record: a play it captured carries tofa's session id
 * as its session key, and a play an earlier import brought in carries the history id.
 */
export function playsOf(serverId: string, rows: TofaWatchHistoryRow[]): SQL | undefined {
  const sessionIds = rows.flatMap((row) => (row.session_id ? [row.session_id] : []));
  const starts = rows.map((row) => Date.parse(row.started_at));
  return and(
    eq(sessions.serverId, serverId),
    gte(sessions.startedAt, new Date(Math.min(...starts) - CAPTURED_START_SLACK_MS)),
    lte(sessions.startedAt, new Date(Math.max(...starts) + CAPTURED_START_SLACK_MS)),
    or(
      inArray(
        sessions.externalSessionId,
        rows.map((row) => row.id)
      ),
      sessionIds.length > 0 ? inArray(sessions.sessionKey, sessionIds) : undefined
    )
  );
}

export async function historyServer(serverId: string) {
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId)).limit(1);
  if (!server) throw new UnrecoverableError(`Server not found: ${serverId}`);
  if (server.historicalAt) throw new ServerHistoricalError(serverId);
  if (SERVER_PROFILES[server.type].serverHistoryImport !== 'tofa') {
    throw new UnrecoverableError(
      `${server.type} servers keep no watch history of their own to import`
    );
  }
  return {
    server,
    client: new TofaClient({ url: server.url, token: server.token, id: server.id }),
  };
}

/**
 * tofa's history from the newest play back to the oldest, a page at a time, each play once.
 * tofa pages by start time alone and takes no tie-breaker, so each page starts just after the
 * oldest play of the last and leaves out the plays that page already held.
 */
export async function* watchHistoryPages(
  client: TofaClient,
  beforeFetch?: () => void
): AsyncGenerator<TofaWatchHistoryRow[]> {
  let before: string | null = null;
  let lastPage = new Set<string>();
  for (;;) {
    beforeFetch?.();
    const page = await client.getWatchHistoryPage(before, PAGE_SIZE);
    const oldest = page.items.at(-1);
    const items = page.items.filter((row) => !lastPage.has(row.id));
    if (!oldest) return;
    if (items.length === 0) {
      // A page of plays that all started in one millisecond cannot be paged past
      console.warn(
        '[TofaHistory] Stopped before the oldest plays: a full page started at',
        oldest.started_at
      );
      return;
    }
    yield items;
    if (!page.has_more) return;
    lastPage = new Set(page.items.map((row) => row.id));
    before = new Date(Date.parse(oldest.started_at) + 1).toISOString();
  }
}
