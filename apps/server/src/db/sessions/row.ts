import { type SQL, between, eq, gte, inArray, sql } from 'drizzle-orm';
import { sessions } from '../schema.js';

type SessionRowRef = { id: string; startedAt: Date | number | string };

/**
 * Floor for reads of active sessions: anything older would have been force-stopped by the
 * stale session sweep, so only the recent chunks are opened. 7 days gives ample buffer.
 */
export const ACTIVE_SESSION_CHUNK_BOUND_MS = 7 * 24 * 60 * 60 * 1000;

export function activeSessionFloor(): Date {
  return new Date(Date.now() - ACTIVE_SESSION_CHUNK_BOUND_MS);
}

/**
 * Match one session by id plus a floor on its started_at. started_at is the compression
 * orderby, so without the floor an id-only read or write scans every compressed batch. The
 * minute of slack covers the microseconds a JS Date drops from the stored timestamptz.
 * Floor only: on live paths the stored started_at can be later than the caller's value.
 */
export function sessionRowById(row: SessionRowRef): SQL {
  const at = new Date(row.startedAt).getTime();
  return sql`(${eq(sessions.id, row.id)} and ${gte(sessions.startedAt, new Date(at - 60_000))})`;
}

/**
 * A read through sessionRowById when the caller knows the start, falling back to the id alone
 * when it doesn't or the floor finds nothing, so a start that was off can't lose the row.
 */
export async function readSessionRow<T>(
  id: string,
  startedAt: Date | number | string | null | undefined,
  read: (where: SQL) => Promise<T | undefined>
): Promise<T | undefined> {
  if (startedAt != null) {
    const row = await read(sessionRowById({ id, startedAt }));
    if (row) return row;
  }
  return read(eq(sessions.id, id));
}

/** Known start: readSessionRow. No start: the active floor first, then the id alone. */
export function readSessionRowOrActive<T>(
  id: string,
  startedAt: Date | number | string | null | undefined,
  read: (where: SQL) => Promise<T | undefined>
): Promise<T | undefined> {
  return readSessionRow(id, startedAt ?? activeSessionFloor(), read);
}

/** Floor pass for every id, then an id-only pass for the ids the floor missed. */
export async function readSessionRows<T extends { id: string }>(
  ids: string[],
  read: (where: SQL) => Promise<T[]>
): Promise<T[]> {
  const recent = await read(
    sql`(${inArray(sessions.id, ids)} and ${gte(sessions.startedAt, activeSessionFloor())})`
  );
  const found = new Set(recent.map((row) => row.id));
  const missed = ids.filter((id) => !found.has(id));
  if (missed.length === 0) return recent;
  return [...recent, ...(await read(inArray(sessions.id, missed)))];
}

/**
 * The given rows by id, with started_at pinned between the earliest start minus a minute and
 * the latest plus a minute, for a write on rows just read.
 */
export function sessionRowsWhere(rows: { id: string; startedAt: Date | string }[]): SQL {
  if (rows.length === 0) return sql`false`;
  const starts = rows.map((row) => new Date(row.startedAt).getTime());
  const window = between(
    sessions.startedAt,
    new Date(Math.min(...starts) - 60_000),
    new Date(Math.max(...starts) + 60_000)
  );
  return sql`(${inArray(
    sessions.id,
    rows.map((row) => row.id)
  )} and ${window})`;
}

/**
 * sessionRowById for a startedAt read from the row itself, so a minute either side pins the
 * write to the one or two chunks around it.
 */
export function storedSessionRowById(row: SessionRowRef): SQL {
  const at = new Date(row.startedAt).getTime();
  const window = between(sessions.startedAt, new Date(at - 60_000), new Date(at + 60_000));
  return sql`(${eq(sessions.id, row.id)} and ${window})`;
}
