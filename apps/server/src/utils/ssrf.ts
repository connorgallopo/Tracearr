import { isIP } from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SsrfBlockedError';
  }
}

function isLinkLocalIPv4(addr: string): boolean {
  const parts = addr.split('.').map(Number);
  return parts[0] === 169 && parts[1] === 254;
}

// fe80::/10 covers fe80:: through febf:: (upper 10 bits fixed)
function isLinkLocalIPv6(addr: string): boolean {
  const normalized =
    addr
      .replace(/^\[|\]$/g, '')
      .split('%')[0]
      ?.toLowerCase() ?? '';
  if (!normalized.startsWith('fe')) return false;
  const secondByte = parseInt(normalized.slice(2, 4), 16);
  return !isNaN(secondByte) && secondByte >= 0x80 && secondByte <= 0xbf;
}

/**
 * Extract the embedded IPv4 address from an IPv4-mapped IPv6 address.
 *
 * WHATWG URL normalizes [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe] before
 * we ever see the hostname, so we handle both the hex-group form that URL
 * normalization produces and the dotted-quad form that may appear in tests
 * or direct calls.
 *
 * Returns null if the address is not IPv4-mapped.
 */
function extractIPv4FromMapped(ipv6: string): string | null {
  const lower = ipv6.toLowerCase();

  // WHATWG-normalized hex-group form produced by the URL parser: ::ffff:xxxx:xxxx
  const hexMatch = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexMatch) {
    const hi = parseInt(hexMatch[1] ?? '0', 16);
    const lo = parseInt(hexMatch[2] ?? '0', 16);
    return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff].join('.');
  }

  // Dotted-quad form (e.g. from direct callers, not from URL normalization)
  const dottedMatch = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(lower);
  if (dottedMatch) {
    return dottedMatch[1] ?? null;
  }

  return null;
}

/**
 * Reject URL schemes other than http/https, link-local IP literals
 * (169.254.0.0/16, fe80::/10), and IPv4-mapped IPv6 addresses that embed
 * a link-local IPv4. RFC 1918, CGNAT/Tailscale, and loopback are
 * deliberately allowed -- Tracearr probes servers at those addresses.
 * Hostname-based URLs are not DNS-resolved; this is defense-in-depth only.
 */
export function assertSafeProbeUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`Malformed URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(
      `Scheme '${parsed.protocol.replace(':', '')}' not permitted; only http and https are allowed`
    );
  }

  // URL.hostname wraps IPv6 literals in brackets; strip them
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const ipVersion = isIP(hostname);

  if (ipVersion === 4 && isLinkLocalIPv4(hostname)) {
    throw new SsrfBlockedError(
      `${hostname} is in the link-local range (169.254.0.0/16) and cannot be probed`
    );
  }

  if (ipVersion === 6) {
    if (isLinkLocalIPv6(hostname)) {
      throw new SsrfBlockedError(
        `${hostname} is in the link-local range (fe80::/10) and cannot be probed`
      );
    }
    // Block IPv4-mapped IPv6 addresses that embed a link-local IPv4.
    // WHATWG URL normalizes [::ffff:169.254.169.254] to [::ffff:a9fe:a9fe]
    // before we receive the hostname, so we must decode it here.
    const embedded = extractIPv4FromMapped(hostname);
    if (embedded && isLinkLocalIPv4(embedded)) {
      throw new SsrfBlockedError(
        `${hostname} is an IPv4-mapped IPv6 address embedding the link-local range (169.254.0.0/16) and cannot be probed`
      );
    }
  }
}

/** Why a probe of the URL is refused, or null when it may be probed. */
export function probeRefusal(rawUrl: string): string | null {
  try {
    assertSafeProbeUrl(rawUrl);
    return null;
  } catch (err) {
    return err instanceof SsrfBlockedError ? err.message : 'URL not permitted';
  }
}
