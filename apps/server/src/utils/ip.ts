/**
 * IP helpers for CIDR matching and IPv6 unique-IP comparison.
 */

import { BlockList, isIP } from 'node:net';

/**
 * Unmap IPv4-mapped IPv6 so dual-stack clients match v4 CIDR rules and
 * count as v4 unique IPs. Handles dotted (::ffff:1.2.3.4) and hex
 * (::ffff:c0a8:164) forms.
 */
function unmapIpv4Mapped(ip: string): string {
  const lower = ip.toLowerCase();

  // ::ffff:192.168.1.100
  if (lower.startsWith('::ffff:')) {
    const rest = ip.slice(7);
    if (isIP(rest) === 4) return rest;
  }

  // ::ffff:c0a8:164 → 192.168.1.100
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1]!, 16);
    const lo = parseInt(hex[2]!, 16);
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
  }

  return ip;
}

/** True if ip falls within cidr. Supports IPv4 and IPv6. */
export function isIpInCidr(ip: string, cidr: string): boolean {
  if (!ip || !cidr) return false;

  const normalized = unmapIpv4Mapped(ip);

  const slash = cidr.lastIndexOf('/');
  if (slash <= 0 || slash === cidr.length - 1) return false;

  const rangeIp = cidr.slice(0, slash);
  const prefix = Number(cidr.slice(slash + 1));

  const ipFamily = isIP(normalized);
  const rangeFamily = isIP(rangeIp);
  if (!ipFamily || !rangeFamily || ipFamily !== rangeFamily) return false;

  const maxPrefix = ipFamily === 4 ? 32 : 128;
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) return false;

  try {
    const list = new BlockList();
    const type = ipFamily === 4 ? 'ipv4' : 'ipv6';
    list.addSubnet(rangeIp, prefix, type);
    return list.check(normalized, type);
  } catch {
    return false;
  }
}

/**
 * Comparison key for unique-IP rules: IPv4 unchanged; IPv6 masked to /64.
 */
export function toNetworkKey(ip: string): string {
  if (!ip) return ip;

  const normalized = unmapIpv4Mapped(ip);
  const family = isIP(normalized);
  if (family === 4) return normalized;
  if (family !== 6) return ip;

  const bytes = parseIpv6ToBytes(normalized);
  if (!bytes) return ip;

  // /64: keep the network prefix, zero the interface identifier
  bytes.fill(0, 8);
  return formatIpv6Bytes(bytes);
}

function parseIpv6ToBytes(ip: string): Uint8Array | null {
  const addr = ip.toLowerCase().split('%')[0] ?? '';
  if (!addr) return null;

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

function formatIpv6Bytes(bytes: Uint8Array): string {
  const hextets: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    hextets.push(((bytes[i]! << 8) | bytes[i + 1]!).toString(16));
  }
  return hextets.join(':');
}
