/**
 * Live TV watched through an iptvtunerr proxy (fork patch)
 *
 * The iptvtunerr Plex proxy gives shared users Live TV by tuning it with the
 * server owner's token, so Plex lists the session under the owner. With
 * IPTVTUNERR_LIVE_VIEWERS_URL set (the proxy's /iptvtunerr/live-viewers, its
 * -live-viewers flag on), Tracearr asks the proxy which Plex account is behind
 * each Live TV client and files the session under that account instead.
 * IPTVTUNERR_LIVE_VIEWERS_KEY is the proxy's read-only key for that list.
 */

import type { ProcessedSession } from '../jobs/poller/types.js';
import { getRedis } from '../lib/redisShared.js';

/** One entry of the proxy's list, keyed by the Plex client identifier. */
export interface ProxyLiveViewer {
  clientIdentifier: string;
  /** The shared user's plex.tv account id; Tracearr's external id for them */
  plexAccountId: string;
  /** Their plex.tv username, as Tracearr stores it */
  username: string;
}

/** The proxy's list, for the Plex server it names. */
export interface ProxyLiveViewerList {
  /** The Plex server's machineIdentifier; empty if the proxy doesn't know it yet */
  machineIdentifier: string;
  byClient: Map<string, ProxyLiveViewer>;
}

/** Plex's local user id for the server owner, as Plex reports owner sessions. */
const PLEX_OWNER_USER_ID = '1';

/** How long a session's attribution is kept in memory after it was last seen. */
const DECISION_TTL_MS = 6 * 60 * 60_000;
/** How long a decision is kept in Redis, so it survives a Tracearr restart... */
const DECISION_REDIS_TTL_S = 24 * 60 * 60;
/** ...renewed at most this often while its session is still seen. */
const DECISION_REFRESH_MS = 60 * 60_000;
const DECISION_REDIS_PREFIX = 'fork:proxy-live-viewer:';
const FETCH_TIMEOUT_MS = 3_000;
const WARN_EVERY_MS = 5 * 60_000;

const emptyList = (): ProxyLiveViewerList => ({ machineIdentifier: '', byClient: new Map() });

let inflight: Promise<ProxyLiveViewerList | null> | null = null;
let lastWarnAt: number | null = null;
/**
 * server|playback|client -> the shared user the session was filed under
 * (null: left under the owner), decided once, when the session was first seen.
 * Also kept in Redis (best effort), so a restart doesn't decide again.
 */
const decisions = new Map<
  string,
  { viewer: ProxyLiveViewer | null; seenAt: number; persistedAt: number }
>();

function parseViewers(body: unknown): ProxyLiveViewerList {
  const list = emptyList();
  const raw = body as { machineIdentifier?: unknown; viewers?: unknown } | null;
  if (typeof raw?.machineIdentifier === 'string') {
    list.machineIdentifier = raw.machineIdentifier;
  }
  if (!Array.isArray(raw?.viewers)) {
    return list;
  }
  for (const entry of raw.viewers) {
    const v = entry as Record<string, unknown>;
    const clientIdentifier = typeof v.clientIdentifier === 'string' ? v.clientIdentifier : '';
    const plexAccountId = typeof v.plexAccountId === 'string' ? v.plexAccountId : '';
    const username = typeof v.username === 'string' ? v.username.trim() : '';
    // Clients with no account are the owner's own devices: nothing to change.
    // Without a username the friend's stored name would be overwritten, so skip.
    if (clientIdentifier && /^\d+$/.test(plexAccountId) && username) {
      list.byClient.set(clientIdentifier, { clientIdentifier, plexAccountId, username });
    }
  }
  return list;
}

async function fetchList(url: string, now: number): Promise<ProxyLiveViewerList | null> {
  const key = process.env.IPTVTUNERR_LIVE_VIEWERS_KEY?.trim();
  try {
    const res = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`status ${res.status}`);
    }
    return parseViewers(await res.json());
  } catch (error) {
    if (lastWarnAt === null || now - lastWarnAt >= WARN_EVERY_MS) {
      lastWarnAt = now;
      console.warn(
        `[ProxyLiveViewers] Could not read ${url}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    // No list: an earlier answer may be out of date (a device can change hands),
    // so it never names a viewer for a new session.
    return null;
  }
}

/**
 * The proxy's list as it is now, or null when it can't be read (or without
 * IPTVTUNERR_LIVE_VIEWERS_URL). Only new sessions ask, once each, so there's
 * no cache to go stale; concurrent callers share one request. The proxy
 * records a tune before Plex reports the session, so a new session finds its
 * viewer.
 */
export async function getProxyLiveViewers(
  now: number = Date.now()
): Promise<ProxyLiveViewerList | null> {
  const url = process.env.IPTVTUNERR_LIVE_VIEWERS_URL?.trim();
  if (!url) {
    return null;
  }
  if (!inflight) {
    inflight = fetchList(url, now).finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

type AttributableSession = Pick<
  ProcessedSession,
  | 'sessionKey'
  | 'plexSessionId'
  | 'mediaType'
  | 'deviceId'
  | 'externalUserId'
  | 'username'
  | 'userThumb'
>;

/** The Plex server the sessions came from. */
interface AttributableServer {
  id: string;
  type: string;
  machineIdentifier?: string | null;
}

/** Live TV sessions Plex filed under the owner: the only ones the proxy's elevation affects. */
function ownerLiveSessions(sessions: AttributableSession[]): AttributableSession[] {
  return sessions.filter(
    (s) => s.mediaType === 'live' && !!s.deviceId && s.externalUserId === PLEX_OWNER_USER_ID
  );
}

/**
 * A session's decision key. Plex's Session.id identifies a playback and isn't
 * reused; sessionKey is a counter Plex restarts from 1 when PMS restarts, so
 * it's only the fallback.
 */
function decisionKey(serverId: string, session: AttributableSession): string {
  const playback = session.plexSessionId
    ? `id:${session.plexSessionId}`
    : `key:${session.sessionKey}`;
  return `${serverId}|${playback}|${session.deviceId}`;
}

function pruneDecisions(now: number): void {
  for (const [key, d] of decisions) {
    if (now - d.seenAt > DECISION_TTL_MS) {
      decisions.delete(key);
    }
  }
}

/**
 * Files each Live TV session Plex listed under the owner under the shared
 * user behind its client. Who that is gets decided once, the first time the
 * session is seen (from `list`, or the owner when `list` is null or doesn't
 * have the client), and kept: a session already recorded is never moved to
 * someone else later, which would duplicate it and run its rules again.
 * Friends' own sessions and other media are never touched. Returns how many
 * sessions were filed under a shared user.
 */
export function attributeProxyLiveViewers(
  serverId: string,
  sessions: AttributableSession[],
  list: ProxyLiveViewerList | null,
  now: number = Date.now(),
  persist?: (key: string, viewer: ProxyLiveViewer | null) => void,
  decideNew = true
): number {
  pruneDecisions(now);
  let changed = 0;
  for (const session of ownerLiveSessions(sessions)) {
    const key = decisionKey(serverId, session);
    let decision = decisions.get(key);
    if (!decision && !decideNew) {
      continue;
    }
    if (!decision) {
      decision = {
        viewer: list?.byClient.get(session.deviceId) ?? null,
        seenAt: now,
        persistedAt: now,
      };
      decisions.set(key, decision);
      persist?.(key, decision.viewer);
    } else if (now - decision.persistedAt >= DECISION_REFRESH_MS) {
      // Still playing: renew its Redis copy before that expires.
      decision.persistedAt = now;
      persist?.(key, decision.viewer);
    }
    decision.seenAt = now;
    const { viewer } = decision;
    if (!viewer) {
      continue;
    }
    session.externalUserId = viewer.plexAccountId;
    session.username = viewer.username;
    // The owner's avatar would otherwise become the friend's on first sight;
    // empty keeps the friend's stored one.
    session.userThumb = '';
    changed++;
  }
  return changed;
}

/**
 * Fetches the list when a session needs a decision and attributes `sessions`
 * from `server`. The list only applies to the Plex server it names: another
 * server's sessions, or a server whose machine identifier Tracearr doesn't
 * know, stay under the owner. `isTracked` says whether Tracearr already
 * records a session (pending or active): one with no decision (it started
 * before this feature, or its decision was lost) stays as it was recorded,
 * so it isn't duplicated under someone else.
 */
export async function attributePlexLiveViewers(
  server: AttributableServer,
  sessions: AttributableSession[],
  isTracked?: (session: AttributableSession) => Promise<TrackedPlayback | null>
): Promise<number> {
  if (server.type !== 'plex') {
    return 0;
  }
  const candidates = ownerLiveSessions(sessions);
  if (candidates.length === 0) {
    return 0;
  }
  // Expired decisions go first, so Redis can restore one that memory dropped.
  pruneDecisions(Date.now());
  await recallDecisions(candidates.map((s) => decisionKey(server.id, s)));
  // Without the URL nothing new is fetched, but decisions already made, and
  // sessions Tracearr already records, keep their user.
  const enabled = !!process.env.IPTVTUNERR_LIVE_VIEWERS_URL?.trim();
  let undecided = candidates.filter((s) => !decisions.has(decisionKey(server.id, s)));
  const decided: [string, ProxyLiveViewer | null][] = [];
  if (isTracked && undecided.length > 0) {
    const now = Date.now();
    const tracked = await Promise.all(undecided.map(async (s) => isTracked(s)));
    undecided = undecided.filter((s, i) => {
      const recorded = tracked[i];
      if (!recorded) {
        return true;
      }
      // Keep the session under whoever it's recorded under.
      const key = decisionKey(server.id, s);
      decisions.set(key, { viewer: recorded.viewer, seenAt: now, persistedAt: now });
      decided.push([key, recorded.viewer]);
      return false;
    });
  }
  let list: ProxyLiveViewerList | null = null;
  if (enabled && undecided.length > 0) {
    const fetched = await getProxyLiveViewers();
    const machine = server.machineIdentifier?.trim();
    if (fetched && machine && fetched.machineIdentifier === machine) {
      list = fetched;
    }
  }
  const changed = attributeProxyLiveViewers(
    server.id,
    sessions,
    list,
    Date.now(),
    (key, viewer) => decided.push([key, viewer]),
    enabled
  );
  await persistDecisions(decided);
  return changed;
}

/** What Tracearr stores about a session it records: enough to tell playbacks apart. */
interface StoredPlayback {
  deviceId?: string | null;
  plexSessionId?: string | null;
}

/** A session Tracearr already records, and who it's recorded under (null: the owner). */
export interface TrackedPlayback {
  viewer: ProxyLiveViewer | null;
}

/** The shared user a recorded session belongs to, or null for the owner (or anything unusable). */
function recordedViewer(
  externalId: string | null | undefined,
  username: string | null | undefined,
  clientIdentifier: string
): ProxyLiveViewer | null {
  if (!externalId || externalId === PLEX_OWNER_USER_ID || !/^\d+$/.test(externalId) || !username) {
    return null;
  }
  return { clientIdentifier, plexAccountId: externalId, username };
}

/**
 * Whether a stored session is this playback: same client, and the same Plex
 * Session.id when both have one (a session key alone can be a recycled one
 * after a PMS restart).
 */
export function samePlayback(stored: StoredPlayback, session: AttributableSession): boolean {
  if ((stored.deviceId ?? '') !== session.deviceId) {
    return false;
  }
  return (
    !stored.plexSessionId ||
    !session.plexSessionId ||
    stored.plexSessionId === session.plexSessionId
  );
}

/**
 * The isTracked check for attributePlexLiveViewers: a pending (unconfirmed)
 * record first, then an active row, each for this playback, with who it's
 * recorded under, so a session whose decision was lost keeps its user.
 */
export function trackedPlaybackCheck(
  serverId: string,
  getPending: (
    serverId: string,
    sessionKey: string
  ) => Promise<{
    processed: StoredPlayback & { externalUserId?: string | null; username?: string | null };
  } | null>,
  findActive: (
    serverId: string,
    sessionKey: string
  ) => Promise<(StoredPlayback & { serverUserId?: string | null }) | null>,
  userOf: (
    serverUserId: string
  ) => Promise<{ externalId: string | null; username: string | null } | null>
): (session: AttributableSession) => Promise<TrackedPlayback | null> {
  return async (session) => {
    const pending = await getPending(serverId, session.sessionKey);
    if (pending && samePlayback(pending.processed, session)) {
      return {
        viewer: recordedViewer(
          pending.processed.externalUserId,
          pending.processed.username,
          session.deviceId
        ),
      };
    }
    const row = await findActive(serverId, session.sessionKey);
    if (!row || !samePlayback(row, session)) {
      return null;
    }
    const user = row.serverUserId ? await userOf(row.serverUserId) : null;
    return { viewer: recordedViewer(user?.externalId, user?.username, session.deviceId) };
  };
}

/** Loads decisions a previous run made (Redis) for sessions this run hasn't decided. */
async function recallDecisions(keys: string[]): Promise<void> {
  const missing = [...new Set(keys)].filter((k) => !decisions.has(k));
  if (missing.length === 0) {
    return;
  }
  try {
    const values = await getRedis().mget(...missing.map((k) => DECISION_REDIS_PREFIX + k));
    const now = Date.now();
    missing.forEach((key, i) => {
      const viewer = parseStoredViewer(values[i]);
      if (viewer !== undefined) {
        // persistedAt 0: renew the Redis copy on this first use.
        decisions.set(key, { viewer, seenAt: now, persistedAt: 0 });
      }
    });
  } catch {
    // Redis unavailable: decide from the list, in memory only.
  }
}

/** A stored decision: a viewer, null (the owner), or undefined when absent or malformed. */
function parseStoredViewer(raw: string | null | undefined): ProxyLiveViewer | null | undefined {
  if (!raw) {
    return undefined;
  }
  try {
    const { viewer } = JSON.parse(raw) as { viewer?: Partial<ProxyLiveViewer> | null };
    if (viewer === null) {
      return null;
    }
    if (
      viewer &&
      typeof viewer.clientIdentifier === 'string' &&
      typeof viewer.plexAccountId === 'string' &&
      /^\d+$/.test(viewer.plexAccountId) &&
      typeof viewer.username === 'string' &&
      viewer.username
    ) {
      return {
        clientIdentifier: viewer.clientIdentifier,
        plexAccountId: viewer.plexAccountId,
        username: viewer.username,
      };
    }
  } catch {
    // malformed: decide again
  }
  return undefined;
}

async function persistDecisions(decided: [string, ProxyLiveViewer | null][]): Promise<void> {
  if (decided.length === 0) {
    return;
  }
  try {
    const tx = getRedis().multi();
    for (const [key, viewer] of decided) {
      tx.set(DECISION_REDIS_PREFIX + key, JSON.stringify({ viewer }), 'EX', DECISION_REDIS_TTL_S);
    }
    await tx.exec();
  } catch {
    // Redis unavailable: the decision still holds in memory.
  }
}

/** Test hook: forget the cached list and every decision. */
export function resetProxyLiveViewersCache(): void {
  inflight = null;
  lastWarnAt = null;
  decisions.clear();
}
