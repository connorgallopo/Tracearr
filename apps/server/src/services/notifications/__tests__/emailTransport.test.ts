import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockCreateTransport = vi.fn();
vi.mock('nodemailer', () => ({
  createTransport: (...args: unknown[]) => mockCreateTransport(...args) as unknown,
}));

import {
  _resetTransportersForTests,
  assertSafeSmtpHost,
  closeAllTransporters,
  closeTransporter,
  describeSmtpError,
  getTransporter,
  smtpExtraHeaders,
  transportOptions,
  type SmtpConfig,
} from '../destinations/emailTransport.js';

const base: SmtpConfig = {
  host: 'smtp.example.com',
  port: '587',
  security: 'starttls',
  username: 'user',
  password: 'pw',
  messagesPerSecond: '3',
};

function fakeTransporter() {
  return { sendMail: vi.fn(), verify: vi.fn(), close: vi.fn() };
}

beforeEach(() => {
  mockCreateTransport.mockReset().mockImplementation(() => fakeTransporter());
});
afterEach(() => _resetTransportersForTests());

describe('transportOptions', () => {
  it('maps starttls to requireTLS on an insecure socket', () => {
    expect(transportOptions(base)).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      requireTLS: true,
      pool: true,
      maxConnections: 2,
      maxMessages: 100,
      rateDelta: 1000,
      rateLimit: 3,
      connectionTimeout: 30_000,
      greetingTimeout: 30_000,
      socketTimeout: 120_000,
      auth: { user: 'user', pass: 'pw' },
    });
  });

  it('maps tls to a secure socket and none to ignoreTLS', () => {
    expect(transportOptions({ ...base, security: 'tls', port: '465' })).toMatchObject({
      port: 465,
      secure: true,
    });
    expect(transportOptions({ ...base, security: 'tls' })).not.toHaveProperty('requireTLS');
    expect(transportOptions({ ...base, security: 'none', port: '25' })).toMatchObject({
      port: 25,
      secure: false,
      ignoreTLS: true,
    });
  });

  it('omits auth without a username and defaults the rate to 2', () => {
    const opts = transportOptions({
      ...base,
      username: null,
      password: null,
      messagesPerSecond: null,
    });
    expect(opts).not.toHaveProperty('auth');
    expect(opts.rateLimit).toBe(2);
  });
});

describe('getTransporter', () => {
  it('reuses one transporter per destination until the config changes, then closes the old one', () => {
    const first = getTransporter('dest-1', base);
    expect(getTransporter('dest-1', { ...base })).toBe(first);
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);

    const second = getTransporter('dest-1', { ...base, password: 'rotated' });
    expect(second).not.toBe(first);
    expect((first as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(
      1
    );
    expect(mockCreateTransport).toHaveBeenLastCalledWith(
      expect.objectContaining({ auth: { user: 'user', pass: 'rotated' } })
    );
  });

  it('keeps destinations apart', () => {
    const a = getTransporter('dest-a', base);
    const b = getTransporter('dest-b', base);
    expect(a).not.toBe(b);
  });

  it('closeTransporter drops the cache entry', () => {
    const first = getTransporter('dest-1', base);
    closeTransporter('dest-1');
    expect((first as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(
      1
    );
    expect(getTransporter('dest-1', base)).not.toBe(first);
  });

  it('closeAllTransporters closes every pool and empties the cache', () => {
    const a = getTransporter('dest-a', base);
    const b = getTransporter('dest-b', base);
    closeAllTransporters();
    expect((a as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect((b as unknown as { close: ReturnType<typeof vi.fn> }).close).toHaveBeenCalledTimes(1);
    expect(getTransporter('dest-a', base)).not.toBe(a);
    expect(mockCreateTransport).toHaveBeenCalledTimes(3);
  });
});

describe('smtpExtraHeaders', () => {
  it('carries the message stream as X-PM-Message-Stream and omits it when blank', () => {
    expect(smtpExtraHeaders({ messageStream: 'broadcast' })).toEqual({
      'X-PM-Message-Stream': 'broadcast',
    });
    expect(smtpExtraHeaders({ messageStream: null })).toEqual({});
    expect(smtpExtraHeaders({})).toEqual({});
  });
});

describe('assertSafeSmtpHost', () => {
  it('allows public, LAN and loopback hosts', () => {
    expect(() => assertSafeSmtpHost('smtp.example.com', '587')).not.toThrow();
    expect(() => assertSafeSmtpHost('192.168.1.10', '25')).not.toThrow();
    expect(() => assertSafeSmtpHost('localhost', '1025')).not.toThrow();
  });
  it('blocks link-local literals in both families', () => {
    expect(() => assertSafeSmtpHost('169.254.169.254', '25')).toThrow(/link-local/);
    expect(() => assertSafeSmtpHost('fe80::1', '25')).toThrow(/link-local/);
  });
  it('rejects a host carrying a scheme, port or path, but still allows an IPv6 literal', () => {
    expect(() => assertSafeSmtpHost('smtp.example.com:465', '587')).toThrow(
      'host must be a hostname or IP address without a scheme, port or path'
    );
    expect(() => assertSafeSmtpHost('2001:db8::1', '587')).not.toThrow();
  });
});

describe('describeSmtpError', () => {
  it('names auth, connection and tls failures by code', () => {
    expect(describeSmtpError(Object.assign(new Error('x'), { code: 'EAUTH' }), base)).toBe(
      'SMTP authentication failed for user at smtp.example.com'
    );
    expect(describeSmtpError(Object.assign(new Error('x'), { code: 'ECONNECTION' }), base)).toBe(
      'Could not connect to smtp.example.com:587'
    );
    expect(describeSmtpError(Object.assign(new Error('x'), { code: 'ESOCKET' }), base)).toBe(
      'TLS failed for smtp.example.com:587; check the security setting'
    );
    expect(describeSmtpError(new Error('boom'), base)).toBe('boom');
  });
});
