import { assertNever } from '@tracearr/shared';
import type { servers } from '../db/schema.js';
import { createLogger } from '../utils/logger.js';
import { readServerFacts } from './mediaServer/byServerType.js';
import { verifyServerAdmin } from './mediaServer/index.js';
import { readServerIdentity, sharesKnownUsers } from './serverIdentity.js';

const log = createLogger('servers');

/**
 * Checks a new address or key for a saved server: the key is an admin's, it reaches the server
 * the row belongs to, and the server's facts read with it. A refusal carries the message to show;
 * code is set when the admin check refused.
 */
export async function verifyServerChange(
  server: typeof servers.$inferSelect,
  target: { url: string; token: string; clientIdentifier?: string }
): Promise<
  | {
      ok: true;
      facts: Awaited<ReturnType<typeof readServerFacts>>;
      backfilledIdentity?: string;
    }
  | { ok: false; message: string; code?: string }
> {
  const { id } = server;
  const { url: targetUrl, token, clientIdentifier } = target;

  switch (server.type) {
    case 'plex':
      if (
        clientIdentifier &&
        server.machineIdentifier &&
        server.machineIdentifier !== clientIdentifier
      ) {
        return {
          ok: false,
          message:
            'Server mismatch: The selected connection belongs to a different server. ' +
            'Please select a connection for the correct server.',
        };
      }
      break;
    case 'jellyfin':
    case 'emby':
    case 'tofa':
    case 'silo':
      break;
    default:
      assertNever(server.type);
  }

  let adminCheck: Awaited<ReturnType<typeof verifyServerAdmin>>;
  try {
    adminCheck = await verifyServerAdmin(server.type, token, targetUrl);
  } catch (error) {
    log.error('Failed to verify server', { err: error, serverId: id, url: targetUrl });
    return {
      ok: false,
      message: 'Failed to connect to the server. Please verify the URL and API key are correct.',
    };
  }
  if (!adminCheck.success) {
    return { ok: false, message: adminCheck.message, code: adminCheck.code };
  }

  const reached = { id, type: server.type, url: targetUrl, token };
  const expectedIdentity =
    server.machineIdentifier ?? (await readServerIdentity(server).catch(() => null));

  const reachedIdentity = await readServerIdentity(reached).catch((error: unknown) => {
    log.error('Failed to read server identity', { err: error, serverId: id, url: targetUrl });
    return null;
  });
  if (reachedIdentity === null) {
    return { ok: false, message: 'Could not read which server answers at that address.' };
  }

  if (expectedIdentity) {
    if (reachedIdentity !== expectedIdentity) {
      return {
        ok: false,
        message:
          'That address or API key reaches a different server. A server can only be pointed at itself.',
      };
    }
  } else {
    const sameUsers = await sharesKnownUsers(reached).catch((error: unknown) => {
      log.error('Failed to compare users', { err: error, serverId: id, url: targetUrl });
      return false;
    });
    if (!sameUsers) {
      return {
        ok: false,
        message:
          'Tracearr has no record of which server this is, cannot reach it with the saved address and key, and finds none of its users at the new address, so it cannot confirm the change points at the same server.',
      };
    }
  }

  let facts: Awaited<ReturnType<typeof readServerFacts>>;
  try {
    facts = await readServerFacts(server.type, targetUrl, token);
  } catch (error) {
    log.error('Failed to read server settings', { err: error, serverId: id, url: targetUrl });
    return { ok: false, message: 'Could not read the API key scopes from the server.' };
  }

  return {
    ok: true,
    facts,
    ...(server.machineIdentifier ? {} : { backfilledIdentity: reachedIdentity }),
  };
}
