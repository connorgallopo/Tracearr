import { describe, expect, it } from 'vitest';
import { DEFAULT_IPV6_HOUSEHOLD_PREFIX, isIpInCidr, toIpNetworkKey } from '../ip.js';

describe('isIpInCidr', () => {
  it('matches IPv4 addresses within a CIDR range', () => {
    expect(isIpInCidr('192.168.1.100', '192.168.1.0/24')).toBe(true);
    expect(isIpInCidr('192.168.2.1', '192.168.1.0/24')).toBe(false);
    expect(isIpInCidr('10.0.5.25', '10.0.0.0/8')).toBe(true);
  });

  it('matches exact IPv4 with /32', () => {
    expect(isIpInCidr('192.168.1.1', '192.168.1.1/32')).toBe(true);
    expect(isIpInCidr('192.168.1.2', '192.168.1.1/32')).toBe(false);
  });

  it('matches IPv6 addresses within a /64 household range', () => {
    expect(isIpInCidr('2001:db8:abcd:7800:58f:b385:9778:7ab6', '2001:db8:abcd:7800::/64')).toBe(
      true
    );
    expect(isIpInCidr('2001:db8:abcd:7800:c969:3c04:cdd4:13bd', '2001:db8:abcd:7800::/64')).toBe(
      true
    );
    expect(isIpInCidr('2001:db8:abcd:7801:58f:b385:9778:7ab6', '2001:db8:abcd:7800::/64')).toBe(
      false
    );
  });

  it('matches compressed and expanded IPv6 forms against the same CIDR', () => {
    expect(isIpInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(isIpInCidr('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::/32')).toBe(true);
  });

  it('rejects mismatched address families', () => {
    expect(isIpInCidr('192.168.1.1', '2001:db8::/32')).toBe(false);
    expect(isIpInCidr('2001:db8::1', '192.168.0.0/16')).toBe(false);
  });

  it('rejects invalid input', () => {
    expect(isIpInCidr('', '192.168.0.0/16')).toBe(false);
    expect(isIpInCidr('192.168.1.1', 'not-a-cidr')).toBe(false);
    expect(isIpInCidr('192.168.1.1', '192.168.0.0/99')).toBe(false);
    expect(isIpInCidr('2001:db8::1', '2001:db8::/129')).toBe(false);
  });
});

describe('toIpNetworkKey', () => {
  it('leaves IPv4 addresses unchanged', () => {
    expect(toIpNetworkKey('192.168.1.100')).toBe('192.168.1.100');
    expect(toIpNetworkKey('8.8.8.8', 48)).toBe('8.8.8.8');
  });

  it('collapses same-/64 IPv6 household addresses to one key by default', () => {
    const a = toIpNetworkKey('2001:db8:abcd:7800:58f:b385:9778:7ab6');
    const b = toIpNetworkKey('2001:db8:abcd:7800:c969:3c04:cdd4:13bd');
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:abcd:7800:0:0:0:0');
    expect(DEFAULT_IPV6_HOUSEHOLD_PREFIX).toBe(64);
  });

  it('treats different /64 networks as different keys', () => {
    const a = toIpNetworkKey('2001:db8:abcd:7800:58f:b385:9778:7ab6');
    const b = toIpNetworkKey('2001:db8:abcd:7801:58f:b385:9778:7ab6');
    expect(a).not.toBe(b);
  });

  it('respects a configurable IPv6 prefix length', () => {
    const fullA = toIpNetworkKey('2001:db8:abcd:7800:58f:b385:9778:7ab6', 128);
    const fullB = toIpNetworkKey('2001:db8:abcd:7800:c969:3c04:cdd4:13bd', 128);
    expect(fullA).not.toBe(fullB);

    const siteA = toIpNetworkKey('2001:db8:abcd:7800:58f:b385:9778:7ab6', 48);
    const siteB = toIpNetworkKey('2001:db8:abcd:7801:58f:b385:9778:7ab6', 48);
    expect(siteA).toBe(siteB);
  });

  it('normalizes compressed IPv6 before masking', () => {
    expect(toIpNetworkKey('2001:db8::1', 64)).toBe(toIpNetworkKey('2001:db8:0:0:1:2:3:4', 64));
  });
});
