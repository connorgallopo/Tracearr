import { getNestedObject, parseOptionalString } from '../../../utils/parsing.js';

/**
 * Jellyfin clears TranscodingInfo on every automatic one-second progress tick when the
 * client's reported PlayMethod is not Transcode, and ffmpeg's next stats line restores
 * it, so a client that misreports a transcode or remux shows it on roughly half of all
 * reads. Holding the last TranscodingInfo seen keeps the decision, bitrate and stream
 * details steady for as long as the same item plays under the same reported method.
 */
const LATCH_TTL_MS = 10 * 60 * 1000;

interface Latched {
  itemId: string;
  playMethod: string | undefined;
  info: Record<string, unknown>;
  seenAt: number;
}

const latched = new Map<string, Latched>();

export function latchTranscodingInfo(
  session: Record<string, unknown>,
  now = Date.now()
): Record<string, unknown> {
  for (const [id, entry] of latched) {
    if (now - entry.seenAt > LATCH_TTL_MS) latched.delete(id);
  }

  const sessionId = parseOptionalString(session.Id);
  if (!sessionId) return session;

  const itemId = parseOptionalString(getNestedObject(session, 'NowPlayingItem')?.Id);
  if (!itemId) {
    latched.delete(sessionId);
    return session;
  }

  const playMethod = parseOptionalString(getNestedObject(session, 'PlayState')?.PlayMethod);
  const info = getNestedObject(session, 'TranscodingInfo');
  if (info) {
    latched.set(sessionId, { itemId, playMethod, info, seenAt: now });
    return session;
  }

  const entry = latched.get(sessionId);
  if (!entry || entry.itemId !== itemId || entry.playMethod !== playMethod) {
    latched.delete(sessionId);
    return session;
  }

  entry.seenAt = now;
  return { ...session, TranscodingInfo: entry.info };
}
