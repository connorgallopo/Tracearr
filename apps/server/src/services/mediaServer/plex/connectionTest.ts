/**
 * Plex connection testing helpers
 *
 * Shared by the Plex auth plugin (server selection during login) and the
 * owner-gated server management routes (available-servers, server-connections,
 * test-connection). Extracted so the login plugin and the Fastify routes use
 * one implementation.
 */

import { BlockList } from 'node:net';
import type { PlexConnectionError, PlexDiscoveredConnection } from '@tracearr/shared';
import { plexHeaders } from '../../../utils/http.js';
import { assertSafeProbeUrl } from '../../../utils/ssrf.js';

// Connection testing timeout in milliseconds
export const CONNECTION_TEST_TIMEOUT = 3000;

// LAN, CGNAT (Tailscale), loopback and link-local
const NON_PUBLIC_IPV4 = new BlockList();
for (const [network, prefix] of [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
] as const) {
  NON_PUBLIC_IPV4.addSubnet(network, prefix);
}

/**
 * The public IPv4 address a plex.direct hostname points at, or null for any
 * other host. Plex relays are plex.direct hosts on the server's own domain
 * whose address rotates, so the address is the only stable way to spot one:
 * a public address that isn't one of the server's own is a relay.
 */
export function plexDirectPublicIp(hostname: string): string | null {
  const match = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})\.[0-9a-f]+\.plex\.direct$/i.exec(
    hostname
  );
  if (!match) return null;
  const ip = match.slice(1).join('.');
  return NON_PUBLIC_IPV4.check(ip, 'ipv4') ? null : ip;
}

/**
 * Categorize a fetch failure into a stable error code + human-readable detail.
 *
 * Maps undici/Node errors (`err.cause.code`) to a small enum the frontend can
 * render with translated labels. The `message` field carries the specifics
 * (hostname, TLS reason, etc.) so the UI can show them inline.
 */
export function categorizeConnectionError(err: unknown): PlexConnectionError {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      return { code: 'timeout', message: `Timed out after ${CONNECTION_TEST_TIMEOUT}ms` };
    }
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    const code = cause?.code;
    const detail = cause?.message ?? err.message;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
      return { code: 'dns', message: detail };
    }
    if (code === 'ECONNREFUSED') {
      return { code: 'refused', message: detail };
    }
    if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
      return { code: 'unreachable', message: detail };
    }
    if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') {
      return { code: 'reset', message: detail };
    }
    if (
      code &&
      (code.startsWith('CERT_') ||
        code.startsWith('ERR_TLS_') ||
        code.startsWith('UNABLE_TO_') ||
        code.includes('SELF_SIGNED'))
    ) {
      return { code: 'tls', message: detail };
    }
    return { code: 'unknown', message: detail };
  }
  return { code: 'unknown', message: 'Connection failed' };
}

/**
 * Test a single connection URI. Shared by bulk discovery and the
 * single-URL test endpoint used to verify custom URLs before save.
 */
export async function testSingleConnection(
  conn: { uri: string; local: boolean; address: string; port: number; custom?: boolean },
  token: string
): Promise<PlexDiscoveredConnection> {
  const start = Date.now();
  try {
    assertSafeProbeUrl(conn.uri);
    const response = await fetch(`${conn.uri}/`, {
      headers: plexHeaders(token),
      signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT),
    });
    if (response.ok) {
      return {
        uri: conn.uri,
        local: conn.local,
        address: conn.address,
        port: conn.port,
        reachable: true,
        latencyMs: Date.now() - start,
        ...(conn.custom ? { custom: true } : {}),
      };
    }
    return {
      uri: conn.uri,
      local: conn.local,
      address: conn.address,
      port: conn.port,
      reachable: false,
      latencyMs: null,
      error: {
        code: 'http',
        message: `HTTP ${response.status} ${response.statusText}`.trim(),
        status: response.status,
      },
      ...(conn.custom ? { custom: true } : {}),
    };
  } catch (err) {
    return {
      uri: conn.uri,
      local: conn.local,
      address: conn.address,
      port: conn.port,
      reachable: false,
      latencyMs: null,
      error: categorizeConnectionError(err),
      ...(conn.custom ? { custom: true } : {}),
    };
  }
}

/**
 * Test connections to a Plex server and return results with reachability info
 */
export async function testServerConnections(
  connections: Array<{
    uri: string;
    local: boolean;
    address: string;
    port: number;
    relay: boolean;
  }>,
  token: string
): Promise<PlexDiscoveredConnection[]> {
  const results = await Promise.all(connections.map((conn) => testSingleConnection(conn, token)));
  return results.sort(compareConnections);
}

/**
 * Reachable first, then local (polling wants the shortest path), then HTTPS,
 * then latency. The first entry is the one Tracearr recommends.
 */
export function compareConnections(
  a: PlexDiscoveredConnection,
  b: PlexDiscoveredConnection
): number {
  if (a.reachable !== b.reachable) return a.reachable ? -1 : 1;
  if (a.local !== b.local) return a.local ? -1 : 1;
  const aHttps = a.uri.startsWith('https://');
  const bHttps = b.uri.startsWith('https://');
  if (aHttps !== bHttps) return aHttps ? -1 : 1;
  if (a.latencyMs !== null && b.latencyMs !== null) {
    return a.latencyMs - b.latencyMs;
  }
  return 0;
}
