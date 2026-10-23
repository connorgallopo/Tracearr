/**
 * Live TV programme changes are not a stream ending and another starting.
 *
 * Plex gives a Live TV session a new session key, and new metadata, at every guide
 * programme boundary, so one viewer watching one channel shows up as a run of sessions
 * a few seconds apart. Tracearr records each programme as its own session, which is
 * right for history, but announcing each one sends a "Stream Ended" and a "Stream
 * Started" per programme. Notifications instead follow the watch:
 *
 * - A Live TV session from the same account on the same device (server, server user
 *   and device id) that starts while another is playing, or at most
 *   LIVE_TV_CHAIN_GAP_MS after it stopped, continues that watch: its start is not
 *   announced. Changing channel is the same viewer on the same TV, so it continues the
 *   watch too.
 * - A Live TV stop is held (a delayed queue job) for LIVE_TV_STOP_HOLD_MS: long enough
 *   for the next programme's session to be first seen within the gap and then
 *   confirmed and written (PLAYBACK_CONFIRM_THRESHOLD_MS later). When it fires, it is
 *   sent only if no session of the watch ends later; the one that does sends it, so a
 *   watch posts one Stream Ended, about the programme it ended on, with the summed
 *   watch time of every programme in it and the first one's start.
 * - Everything is read from the sessions table when the decision is made, so nothing
 *   is lost to a restart: the held stop is a delayed BullMQ job in Redis and fires when
 *   the worker is back (at once if it is overdue). A stop that was sent is remembered
 *   in Redis for two days, so a programme whose start is decided after its watch's
 *   Stream Ended went out (Tracearr was down across the boundary) is announced as a
 *   new watch rather than folded into one already reported.
 *
 * Sessions without a device id and every other media type are announced as before.
 */

import { and, asc, eq, gte } from 'drizzle-orm';
import { db } from '../../db/client.js';
import { sessions } from '../../db/schema.js';
import { PLAYBACK_CONFIRM_THRESHOLD_MS } from '../../jobs/poller/types.js';
import { getRedis } from '../../lib/redisShared.js';
import type { ActiveSession } from '@tracearr/shared';

/** The longest gap between one programme's stop and the next one's start that is still one watch. */
export const LIVE_TV_CHAIN_GAP_MS = 90_000;

/** How long a Live TV stop waits: the gap, the next session's confirmation, and polling slack. */
export const LIVE_TV_STOP_HOLD_MS = LIVE_TV_CHAIN_GAP_MS + PLAYBACK_CONFIRM_THRESHOLD_MS + 30_000;

/** How far back a watch is looked for. */
const LOOKBACK_MS = 24 * 60 * 60 * 1000;

const ENDED_PREFIX = 'fork:live-tv-ended:';
const ENDED_TTL_SECONDS = 2 * 24 * 60 * 60;

/** One recorded Live TV session of a viewer. */
export interface LiveSegment {
  id: string;
  startedAt: Date | string;
  stoppedAt: Date | string | null;
  durationMs: number | null;
}

/** A queued job's payload has been through JSON, so its dates may be strings. */
type SessionLike = Pick<
  ActiveSession,
  'id' | 'serverId' | 'serverUserId' | 'deviceId' | 'mediaType' | 'durationMs'
> & { startedAt: Date | string; stoppedAt: Date | string | null };

const ms = (value: Date | string): number => new Date(value).getTime();
const endOf = (s: LiveSegment): number => (s.stoppedAt === null ? Infinity : ms(s.stoppedAt));

/** Whether this session's notifications follow the watch rather than the session. */
export function followsLiveTvWatch(
  session: Pick<ActiveSession, 'mediaType' | 'deviceId'>
): boolean {
  return session.mediaType === 'live' && !!session.deviceId;
}

/** A before b: by start, then by id, so two segments never both come first. */
function startsBefore(a: LiveSegment, b: LiveSegment): boolean {
  const d = ms(a.startedAt) - ms(b.startedAt);
  return d !== 0 ? d < 0 : a.id < b.id;
}

/** a ends after b: by stop (playing ends last), then by id. */
function endsAfter(a: LiveSegment, b: LiveSegment): boolean {
  const ea = endOf(a);
  const eb = endOf(b);
  return ea !== eb ? ea > eb : a.id > b.id;
}

/**
 * Whether a starting session continues an earlier one of the same viewer: one that
 * started first and is still playing, or stopped at most the gap before this start.
 * One whose Stream Ended already went out (`ended`) starts nothing new.
 */
export function continuesWatch(
  start: LiveSegment,
  segments: LiveSegment[],
  ended: ReadonlySet<string>
): boolean {
  return segments.some(
    (p) =>
      p.id !== start.id &&
      !ended.has(p.id) &&
      startsBefore(p, start) &&
      endOf(p) >= ms(start.startedAt) - LIVE_TV_CHAIN_GAP_MS
  );
}

/**
 * The watch a stopped session ends, or null when another session of the viewer carries
 * on past it (one that started before this stop plus the gap and ends later): that one's
 * stop speaks for the watch. The watch is every session joined to this one by gaps no
 * longer than LIVE_TV_CHAIN_GAP_MS, back to one whose Stream Ended already went out.
 */
export function watchEndedBy(
  stop: LiveSegment,
  segments: LiveSegment[],
  ended: ReadonlySet<string>
): { startedAt: Date; durationMs: number; segments: number } | null {
  const stopEnd = endOf(stop);
  const carriesOn = segments.some(
    (r) =>
      r.id !== stop.id &&
      !ended.has(r.id) &&
      ms(r.startedAt) <= stopEnd + LIVE_TV_CHAIN_GAP_MS &&
      endsAfter(r, stop)
  );
  if (carriesOn) return null;

  const watch = new Map<string, LiveSegment>([[stop.id, stop]]);
  let first = ms(stop.startedAt);
  for (let grew = true; grew;) {
    grew = false;
    for (const s of segments) {
      if (watch.has(s.id) || ended.has(s.id)) continue;
      if (endOf(s) >= first - LIVE_TV_CHAIN_GAP_MS && ms(s.startedAt) <= stopEnd) {
        watch.set(s.id, s);
        first = Math.min(first, ms(s.startedAt));
        grew = true;
      }
    }
  }

  let durationMs = 0;
  for (const s of watch.values()) durationMs += s.durationMs ?? 0;
  return { startedAt: new Date(first), durationMs, segments: watch.size };
}

/** The viewer's Live TV sessions from a day before `from` on. */
async function viewerSegments(session: SessionLike, from: number): Promise<LiveSegment[]> {
  return db
    .select({
      id: sessions.id,
      startedAt: sessions.startedAt,
      stoppedAt: sessions.stoppedAt,
      durationMs: sessions.durationMs,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.serverUserId, session.serverUserId),
        eq(sessions.serverId, session.serverId),
        eq(sessions.deviceId, session.deviceId ?? ''),
        eq(sessions.mediaType, 'live'),
        gte(sessions.startedAt, new Date(from - LOOKBACK_MS))
      )
    )
    .orderBy(asc(sessions.startedAt))
    .limit(500);
}

/** Which of these sessions' Stream Ended already went out. Redis unreachable: none known. */
async function endedAmong(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  try {
    const values = await getRedis().mget(...ids.map((id) => ENDED_PREFIX + id));
    return new Set(ids.filter((_, i) => values[i] !== null));
  } catch {
    return new Set();
  }
}

async function markEnded(id: string): Promise<void> {
  try {
    await getRedis().set(ENDED_PREFIX + id, '1', 'EX', ENDED_TTL_SECONDS);
  } catch {
    // Only matters if a restart split a watch; the stop itself still goes out.
  }
}

/** The session itself, as the database has it when it has it, else as the event carried it. */
function selfSegment(session: SessionLike, segments: LiveSegment[]): LiveSegment {
  return (
    segments.find((s) => s.id === session.id) ?? {
      id: session.id,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt ?? new Date(),
      durationMs: session.durationMs,
    }
  );
}

/**
 * Whether a Live TV start continues the viewer's watch, so it is not announced. A failed
 * read announces it, as before.
 */
export async function liveTvStartContinues(session: SessionLike): Promise<boolean> {
  if (!followsLiveTvWatch(session)) return false;
  try {
    const segments = await viewerSegments(session, ms(session.startedAt));
    const ended = await endedAmong(segments.map((s) => s.id).filter((id) => id !== session.id));
    return continuesWatch({ ...selfSegment(session, segments), stoppedAt: null }, segments, ended);
  } catch (error) {
    console.warn('[Notifications] Live TV watch lookup failed, announcing the start', error);
    return false;
  }
}

/**
 * A held Live TV stop, once its hold is over: null when the watch carries on in another
 * session, else the payload to send, with the watch's first start and summed duration
 * (its programme stays the one it ended on). A failed read sends it unchanged.
 */
export async function resolveHeldLiveTvStop(session: ActiveSession): Promise<ActiveSession | null> {
  if (!followsLiveTvWatch(session)) return session;
  let watch: ReturnType<typeof watchEndedBy>;
  try {
    const segments = await viewerSegments(session, ms(session.startedAt));
    const self = selfSegment(session, segments);
    const all = segments.some((s) => s.id === self.id) ? segments : [...segments, self];
    const ended = await endedAmong(all.map((s) => s.id).filter((id) => id !== session.id));
    watch = watchEndedBy(self, all, ended);
  } catch (error) {
    console.warn('[Notifications] Live TV watch lookup failed, sending the stop as it is', error);
    return session;
  }
  if (!watch) return null;
  await markEnded(session.id);
  return { ...session, startedAt: watch.startedAt, durationMs: watch.durationMs };
}
