import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

const INFO = 'tracearr-email-links-v1';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 48 chars of base64url uuid, a dot, 43 chars of base64url HMAC-SHA256. */
export const UNSUBSCRIBE_TOKEN_MAX_LENGTH = 92;

let key: Buffer | null = null;

/** Same precedence as the destination crypto: a well-formed ENCRYPTION_KEY, else JWT_SECRET; its own info string so the keys differ. */
function linkKey(): Buffer {
  if (key) return key;
  const explicit = process.env.ENCRYPTION_KEY;
  let secret: string | Buffer | undefined = process.env.JWT_SECRET;
  if (explicit) {
    if (!/^[0-9a-f]{64}$/i.test(explicit)) {
      throw new Error('ENCRYPTION_KEY is set but is not 64 hex characters; fix or unset it');
    }
    secret = Buffer.from(explicit, 'hex');
  }
  if (!secret) throw new Error('JWT_SECRET is required to sign email links');
  key = Buffer.from(hkdfSync('sha256', secret, '', INFO, 32));
  return key;
}

export function _resetLinkKeyForTests(): void {
  key = null;
}

function mac(id: Buffer): Buffer {
  return createHmac('sha256', linkKey()).update(id).digest();
}

export function signUnsubscribeToken(recipientId: string): string {
  const id = Buffer.from(recipientId, 'utf8');
  return `${id.toString('base64url')}.${mac(id).toString('base64url')}`;
}

export function verifyUnsubscribeToken(token: string): string | null {
  if (token.length === 0 || token.length > UNSUBSCRIBE_TOKEN_MAX_LENGTH) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [idPart, macPart] = parts as [string, string];
  const id = Buffer.from(idPart, 'base64url');
  const given = Buffer.from(macPart, 'base64url');
  const expected = mac(id);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  const recipientId = id.toString('utf8');
  return UUID.test(recipientId) ? recipientId : null;
}

export function newViewToken(): string {
  return randomBytes(32).toString('base64url');
}
