/**
 * Encryption utilities for sensitive data (server tokens, API keys)
 * Uses AES-256-GCM for authenticated encryption
 *
 * NOTE: Token encryption is being phased out. This module now primarily
 * supports migrating existing encrypted tokens to plain text storage.
 * New tokens are stored in plain text (the DB is localhost-only in supervised mode).
 */

import { createDecipheriv } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

// Minimum length for an encrypted token: IV (16) + AuthTag (16) + at least 1 byte ciphertext, base64 encoded
const MIN_ENCRYPTED_LENGTH = Math.ceil(((IV_LENGTH + AUTH_TAG_LENGTH + 1) * 4) / 3);

let encryptionKey: Buffer | null = null;

/**
 * Initialize the encryption module with the key from environment.
 * This is now optional - only needed for migrating existing encrypted tokens.
 * Returns true if initialized, false if no key available.
 */
export function initializeEncryption(): boolean {
  const keyHex = process.env.ENCRYPTION_KEY;

  if (!keyHex) {
    // No encryption key - that's fine, tokens will be stored in plain text
    return false;
  }

  // Key should be 32 bytes (64 hex chars) for AES-256
  if (keyHex.length !== KEY_LENGTH * 2) {
    // Invalid key format - log warning but don't fail
    console.warn(
      `ENCRYPTION_KEY has invalid length (${keyHex.length} chars, expected ${KEY_LENGTH * 2}). ` +
        'Encrypted token migration will be skipped.'
    );
    return false;
  }

  encryptionKey = Buffer.from(keyHex, 'hex');
  return true;
}

/**
 * Check if encryption is initialized (key is available for decryption)
 */
export function isEncryptionInitialized(): boolean {
  return encryptionKey !== null;
}

/**
 * Get the encryption key, returning null if not initialized
 */
function getKey(): Buffer | null {
  return encryptionKey;
}

/**
 * Check if a token looks like it might be encrypted.
 * Encrypted tokens are base64-encoded and have a minimum length.
 * Plain text tokens (Plex/Jellyfin API keys) are typically shorter alphanumeric strings.
 */
export function looksEncrypted(token: string): boolean {
  // Too short to be encrypted
  if (token.length < MIN_ENCRYPTED_LENGTH) {
    return false;
  }

  // Check if it's valid base64 (encrypted tokens are base64)
  try {
    const decoded = Buffer.from(token, 'base64');
    // Re-encode and compare - if it's valid base64, it should round-trip
    const reencoded = decoded.toString('base64');
    // Allow for padding differences
    if (reencoded.replace(/=+$/, '') !== token.replace(/=+$/, '')) {
      return false;
    }
    // Must be at least IV + AuthTag + 1 byte
    return decoded.length >= IV_LENGTH + AUTH_TAG_LENGTH + 1;
  } catch {
    return false;
  }
}

/**
 * Try to decrypt a value. Returns the decrypted string if successful,
 * or null if decryption fails (wrong key, not encrypted, etc.)
 */
export function tryDecrypt(encryptedValue: string): string | null {
  const key = getKey();
  if (!key) {
    return null;
  }

  try {
    // Decode the combined value
    const combined = Buffer.from(encryptedValue, 'base64');

    // Must have at least IV + AuthTag + 1 byte of ciphertext
    if (combined.length < IV_LENGTH + AUTH_TAG_LENGTH + 1) {
      return null;
    }

    // Extract iv, authTag, and ciphertext
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
    const ciphertext = combined.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext);
    decrypted = Buffer.concat([decrypted, decipher.final()]);

    return decrypted.toString('utf8');
  } catch {
    // Decryption failed - wrong key, corrupted data, or not encrypted
    return null;
  }
}

/**
 * Decrypt a value encrypted with encrypt()
 * Returns the original plaintext string
 * @throws Error if decryption fails
 * @deprecated Use tryDecrypt() for migration, store tokens in plain text going forward
 */
export function decrypt(encryptedValue: string): string {
  const result = tryDecrypt(encryptedValue);
  if (result === null) {
    throw new Error('Decryption failed - encryption key may have changed or data is corrupted');
  }
  return result;
}

/**
 * Migrate a token from encrypted to plain text format.
 * Returns the plain text token, whether it was encrypted or not.
 *
 * @param token - The token (may be encrypted or plain text)
 * @returns Object with plainText token and whether migration occurred
 */
export function migrateToken(token: string): { plainText: string; wasEncrypted: boolean } {
  // If it doesn't look encrypted, assume it's already plain text
  if (!looksEncrypted(token)) {
    return { plainText: token, wasEncrypted: false };
  }

  // Try to decrypt it
  const decrypted = tryDecrypt(token);
  if (decrypted !== null) {
    return { plainText: decrypted, wasEncrypted: true };
  }

  // Looks encrypted but couldn't decrypt - might be plain text that happens to look like base64,
  // or encrypted with a different key. Return as-is and let it fail at runtime if it's wrong.
  return { plainText: token, wasEncrypted: false };
}
