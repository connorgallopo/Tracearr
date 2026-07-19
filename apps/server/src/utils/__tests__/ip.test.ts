import { describe, it, expect } from 'vitest';
import { isIpInCidr, toNetworkKey } from '../ip.js';

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

  it('matches IPv6 addresses within a /64 CIDR', () => {
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

  it('matches compressed and expanded IPv6 forms', () => {
    expect(isIpInCidr('2001:db8::1', '2001:db8::/32')).toBe(true);
    expect(isIpInCidr('2001:0db8:0000:0000:0000:0000:0000:0001', '2001:db8::/32')).toBe(true);
  });

  it('unmaps IPv4-mapped addresses before matching a v4 CIDR', () => {
    expect(isIpInCidr('::ffff:192.168.1.100', '192.168.1.0/24')).toBe(true);
    expect(isIpInCidr('::ffff:192.168.2.1', '192.168.1.0/24')).toBe(false);
    expect(isIpInCidr('::ffff:10.0.5.25', '10.0.0.0/8')).toBe(true);
    // Hex form: ::ffff:c0a8:164 === 192.168.1.100
    expect(isIpInCidr('::ffff:c0a8:164', '192.168.1.0/24')).toBe(true);
    expect(isIpInCidr('::ffff:c0a8:201', '192.168.1.0/24')).toBe(false);
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

describe('toNetworkKey', () => {
  it('leaves IPv4 addresses unchanged', () => {
    expect(toNetworkKey('192.168.1.100')).toBe('192.168.1.100');
    expect(toNetworkKey('8.8.8.8')).toBe('8.8.8.8');
  });

  it('collapses IPv6 addresses in the same /64 to one key', () => {
    const a = toNetworkKey('2001:db8:abcd:7800:58f:b385:9778:7ab6');
    const b = toNetworkKey('2001:db8:abcd:7800:c969:3c04:cdd4:13bd');
    expect(a).toBe(b);
    expect(a).toBe('2001:db8:abcd:7800:0:0:0:0');
  });

  it('treats different /64 networks as different keys', () => {
    const a = toNetworkKey('2001:db8:abcd:7800:58f:b385:9778:7ab6');
    const b = toNetworkKey('2001:db8:abcd:7801:58f:b385:9778:7ab6');
    expect(a).not.toBe(b);
  });

  it('normalizes compressed IPv6 before masking', () => {
    expect(toNetworkKey('2001:db8::1')).toBe(toNetworkKey('2001:db8:0:0:1:2:3:4'));
  });

  it('unmaps IPv4-mapped addresses so they compare as IPv4', () => {
    expect(toNetworkKey('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(toNetworkKey('::ffff:8.8.8.8')).not.toBe(toNetworkKey('::ffff:1.1.1.1'));
    expect(toNetworkKey('::ffff:c0a8:164')).toBe('192.168.1.100');
    expect(toNetworkKey('::ffff:c0a8:164')).toBe(toNetworkKey('::ffff:192.168.1.100'));
  });
});
