/**
 * Reading tofa's own record of finished plays, for the history import and the profile backfill:
 * the server and its client, the history a page at a time, and the plays in Tracearr a page
 * records.
 */

import type { SQL } from 'drizzle-orm';
import { TofaClient } from '../mediaServer/tofa/client.js';
import type { TofaWatchHistoryRow } from '../mediaServer/tofa/types.js';
import { historyPlaysOf, historyServerRow } from './serverHistory.js';

const PAGE_SIZE = 200;

/**
 * The plays in Tracearr that history rows record: a play it captured carries tofa's session id
 * as its session key, and a play an earlier import brought in carries the history id.
 */
export function playsOf(serverId: string, rows: TofaWatchHistoryRow[]): SQL | undefined {
  return historyPlaysOf(
    serverId,
    rows.map((row) => ({
      historyId: row.id,
      sessionId: row.session_id ?? null,
      startedAt: new Date(row.started_at),
    }))
  );
}

export async function historyServer(serverId: string) {
  const server = await historyServerRow(serverId, 'tofa');
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
