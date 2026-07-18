/**
 * IP helpers for CIDR matching and IPv6 household (network-prefix) comparison.
 */

import { BlockList, isIP } from 'node:net';

export const DEFAULT_IPV6_HOUSEHOLD_PREFIX = 64;

/** True if ip falls within cidr. Supports IPv4 and IPv6. */
export function isIpInCidr(ip: string, cidr: string): boolean {
  if (!ip || !cidr) return false;

  const slash = cidr.lastIndexOf('/');
  if (slash <= 0 || slash === cidr.length - 1) return false;

  const rangeIp = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));

  const ipFamily = isIP(ip);
  const rangeFamily = isIP(rangeIp);
  if (!ipFamily || !rangeFamily || ipFamily !== rangeFamily) return false;

  const maxPrefix = ipFamily === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return false;

  try {
    const list = new BlockList();
    const type = ipFamily === 4 ? 'ipv4' : 'ipv6';
    list.addSubnet(rangeIp, prefix, type);
    return list.check(ip, type);
  } catch {
    return false;
  }
}

/**
 * Household comparison key: IPv4 unchanged; IPv6 masked to prefix (default /64).
 */
export function toIpNetworkKey(
  ip: string,
  ipv6PrefixLength: number = DEFAULT_IPV6_HOUSEHOLD_PREFIX
): string {
  if (!ip) return ip;

  const family = isIP(ip);
  if (family === 4) return ip;
  if (family !== 6) return ip;

  const prefix = clampPrefix(ipv6PrefixLength, 128);
  const bytes = parseIpv6ToBytes(ip);
  if (!bytes) return ip;

  applyPrefixMask(bytes, prefix);
  return formatIpv6Bytes(bytes);
}

function clampPrefix(prefix: number, max: number): number {
  if (!Number.isFinite(prefix)) return DEFAULT_IPV6_HOUSEHOLD_PREFIX;
  return Math.min(max, Math.max(0, Math.trunc(prefix)));
}

function parseIpv6ToBytes(ip: string): Uint8Array | null {
  let addr = ip.toLowerCase().split('%')[0] ?? '';
  if (!addr) return null;

  // Trailing dotted-quad (::ffff:1.2.3.4) → two hextets
  if (addr.includes('.')) {
    const lastColon = addr.lastIndexOf(':');
    if (lastColon < 0) return null;
    const v4 = addr.slice(lastColon + 1);
    const octets = v4.split('.').map((p) => Number(p));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    addr = `${addr.slice(0, lastColon)}:${hi}:${lo}`;
  }

  let parts: string[];
  if (addr.includes('::')) {
    const [left = '', right = ''] = addr.split('::');
    const leftParts = left ? left.split(':') : [];
    const rightParts = right ? right.split(':') : [];
    const missing = 8 - leftParts.length - rightParts.length;
    if (missing < 0) return null;
    parts = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  } else {
    parts = addr.split(':');
  }

  if (parts.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    const hextet = parts[i]!;
    if (!/^[0-9a-f]{1,4}$/.test(hextet)) return null;
    const value = parseInt(hextet, 16);
    bytes[i * 2] = (value >> 8) & 0xff;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function applyPrefixMask(bytes: Uint8Array, prefix: number): void {
  const fullBytes = Math.floor(prefix / 8);
  const remBits = prefix % 8;

  for (let i = fullBytes + (remBits > 0 ? 1 : 0); i < bytes.length; i++) {
    bytes[i] = 0;
  }

  if (remBits > 0 && fullBytes < bytes.length) {
    bytes[fullBytes]! &= (0xff << (8 - remBits)) & 0xff;
  }
}

function formatIpv6Bytes(bytes: Uint8Array): string {
  const hextets: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    hextets.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  }
  return hextets.join(':');
}
