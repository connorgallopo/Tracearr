import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { createTransport, type Transporter } from 'nodemailer';
import type SMTPPool from 'nodemailer/lib/smtp-pool/index.js';
import type { EmailSecurity } from '@tracearr/shared';
import { assertSafeProbeUrl } from '../../../utils/ssrf.js';

export interface SmtpConfig {
  host: string;
  port: string;
  security: EmailSecurity;
  username?: string | null;
  password?: string | null;
  messagesPerSecond?: string | null;
}

const DEFAULT_RATE = 2;

export function transportOptions(config: SmtpConfig): SMTPPool.Options {
  const rate = Number(config.messagesPerSecond);
  const base: SMTPPool.Options = {
    host: config.host,
    port: Number(config.port),
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    rateDelta: 1000,
    rateLimit: Number.isInteger(rate) && rate > 0 ? rate : DEFAULT_RATE,
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
    ...(config.username ? { auth: { user: config.username, pass: config.password ?? '' } } : {}),
  };
  switch (config.security) {
    case 'tls':
      return { ...base, secure: true };
    case 'starttls':
      return { ...base, secure: false, requireTLS: true };
    case 'none':
      return { ...base, secure: false, ignoreTLS: true };
  }
}

export function createTransporter(config: SmtpConfig): Transporter {
  return createTransport(transportOptions(config));
}

const transporters = new Map<string, { hash: string; transporter: Transporter }>();

function configHash(config: SmtpConfig): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        config.host,
        config.port,
        config.security,
        config.username ?? '',
        config.password ?? '',
        config.messagesPerSecond ?? '',
      ])
    )
    .digest('hex');
}

/** Use the result immediately: a pool closed by a config change never settles a send queued after close(). */
export function getTransporter(destinationId: string, config: SmtpConfig): Transporter {
  const hash = configHash(config);
  const cached = transporters.get(destinationId);
  if (cached && cached.hash === hash) return cached.transporter;
  cached?.transporter.close();
  const transporter = createTransporter(config);
  transporters.set(destinationId, { hash, transporter });
  return transporter;
}

export function closeTransporter(destinationId: string): void {
  const cached = transporters.get(destinationId);
  if (!cached) return;
  cached.transporter.close();
  transporters.delete(destinationId);
}

export function closeAllTransporters(): void {
  for (const id of transporters.keys()) closeTransporter(id);
}

export function _resetTransportersForTests(): void {
  transporters.clear();
}

/** The webhook policy, applied to a bare host: link-local literals are refused, LAN and loopback allowed. */
export function assertSafeSmtpHost(host: string, port: string): void {
  const isIPv6 = isIP(host) === 6;
  if (/[/\s]/.test(host) || (host.includes(':') && !isIPv6)) {
    throw new Error('host must be a hostname or IP address without a scheme, port or path');
  }
  assertSafeProbeUrl(`http://${isIPv6 ? `[${host}]` : host}:${port}`);
}

export interface MessageStreamConfig {
  messageStream?: string | null;
}

/** Both send paths build their sendMail input from this, so the Postmark stream header stays in one place. */
export function smtpExtraHeaders(config: MessageStreamConfig): Record<string, string> {
  return config.messageStream ? { 'X-PM-Message-Stream': config.messageStream } : {};
}

export function describeSmtpError(error: unknown, config: SmtpConfig): string {
  const code =
    typeof error === 'object' && error !== null ? (error as { code?: string }).code : undefined;
  switch (code) {
    case 'EAUTH':
      return `SMTP authentication failed for ${config.username || 'anonymous'} at ${config.host}`;
    case 'ECONNECTION':
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'EDNS':
      return `Could not connect to ${config.host}:${config.port}`;
    case 'ESOCKET':
      return `TLS failed for ${config.host}:${config.port}; check the security setting`;
    default:
      return error instanceof Error ? error.message : 'SMTP error';
  }
}
