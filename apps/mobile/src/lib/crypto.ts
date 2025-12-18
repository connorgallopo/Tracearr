/**
 * Push Notification Payload Encryption/Decryption
 *
 * Uses AES-256-GCM (Authenticated Encryption with Associated Data)
 * for secure push notification payloads.
 *
 * Security properties:
 * - Confidentiality: Only the intended device can read the payload
 * - Integrity: Tampered payloads are detected and rejected
 * - Per-device keys: Each device has a unique derived key
 */
import crypto from 'react-native-quick-crypto';
import * as SecureStore from 'expo-secure-store';
import type { EncryptedPushPayload, NotificationEventType } from '@tracearr/shared';

// Storage key for the per-device encryption secret
const DEVICE_SECRET_KEY = 'tracearr_device_secret';

// AES-256-GCM parameters
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits (recommended for GCM)
const SALT_LENGTH = 16; // 128 bits (NIST recommended minimum)
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Decrypted push payload structure
 */
export interface DecryptedPayload {
  type: NotificationEventType | 'data_sync';
  title?: string;
  body?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Generate or retrieve the device-specific encryption secret
 * This secret is used along with the server's key to derive the encryption key
 */
export async function getDeviceSecret(): Promise<string> {
  let secret = await SecureStore.getItemAsync(DEVICE_SECRET_KEY);

  if (!secret) {
    // Generate a new 32-byte random secret
    const randomBytes = crypto.randomBytes(32);
    secret = Buffer.from(randomBytes).toString('base64');
    await SecureStore.setItemAsync(DEVICE_SECRET_KEY, secret);
    console.log('[Crypto] Generated new device secret');
  }

  return secret;
}

/**
 * Derive the encryption key using PBKDF2
 *
 * The key is derived from:
 * - Device secret (stored locally)
 * - Server key identifier (sent with encrypted payload)
 *
 * This ensures each device has a unique key.
 */
export async function deriveKey(deviceSecret: string, salt: Buffer): Promise<Buffer> {
  // Use PBKDF2 with 100,000 iterations for key derivation
  // Note: react-native-quick-crypto uses uppercase hash names
  const key = crypto.pbkdf2Sync(deviceSecret, salt, 100000, KEY_LENGTH, 'SHA-256');

  return Buffer.from(key);
}

/**
 * Decrypt an encrypted push notification payload
 */
export async function decryptPushPayload(
  encrypted: EncryptedPushPayload
): Promise<DecryptedPayload> {
  // Validate version
  if (encrypted.v !== 1) {
    throw new Error(`Unsupported encryption version: ${encrypted.v}`);
  }

  try {
    // Get device secret
    const deviceSecret = await getDeviceSecret();

    // Decode Base64 values
    const iv = Buffer.from(encrypted.iv, 'base64');
    const salt = Buffer.from(encrypted.salt, 'base64');
    const ciphertext = Buffer.from(encrypted.ct, 'base64');
    const authTag = Buffer.from(encrypted.tag, 'base64');

    // Validate lengths
    if (iv.length !== IV_LENGTH) {
      throw new Error(`Invalid IV length: ${iv.length}`);
    }
    if (salt.length !== SALT_LENGTH) {
      throw new Error(`Invalid salt length: ${salt.length}`);
    }
    if (authTag.length !== AUTH_TAG_LENGTH) {
      throw new Error(`Invalid auth tag length: ${authTag.length}`);
    }

    // Derive key using the separate salt from payload
    const key = await deriveKey(deviceSecret, salt);

    // Create decipher
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv) as ReturnType<
      typeof crypto.createDecipheriv
    > & {
      setAuthTag: (tag: Buffer) => void;
    };
    decipher.setAuthTag(authTag);

    // Decrypt
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

    // Parse JSON
    const payload = JSON.parse(decrypted.toString('utf8')) as DecryptedPayload;

    return payload;
  } catch (error) {
    console.error('[Crypto] Decryption failed:', error);
    throw new Error('Failed to decrypt push payload');
  }
}

/**
 * Encrypt data for testing purposes (client-side encryption)
 * This is primarily used for development/testing.
 * In production, encryption happens on the server.
 */
export async function encryptData(data: Record<string, unknown>): Promise<EncryptedPushPayload> {
  try {
    const deviceSecret = await getDeviceSecret();

    // Generate random IV and salt separately (NIST: salt should be at least 128 bits)
    const iv = crypto.randomBytes(IV_LENGTH);
    const salt = crypto.randomBytes(SALT_LENGTH);

    // Derive key using proper random salt (wrap in Buffer for type compatibility)
    const key = await deriveKey(deviceSecret, Buffer.from(salt));

    // Create cipher
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv) as ReturnType<
      typeof crypto.createCipheriv
    > & {
      getAuthTag: () => Buffer;
    };

    // Encrypt
    const plaintext = Buffer.from(JSON.stringify(data), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    // Get auth tag
    const authTag = cipher.getAuthTag();

    return {
      v: 1,
      iv: Buffer.from(iv).toString('base64'),
      salt: Buffer.from(salt).toString('base64'),
      ct: encrypted.toString('base64'),
      tag: authTag.toString('base64'),
    };
  } catch (error) {
    console.error('[Crypto] Encryption failed:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Check if encryption is available on this device
 */
export function isEncryptionAvailable(): boolean {
  try {
    // Test if crypto functions are available
    const testBytes = crypto.randomBytes(16);
    return testBytes.length === 16;
  } catch {
    return false;
  }
}

/**
 * Clear the device secret (on logout/unpair)
 */
export async function clearDeviceSecret(): Promise<void> {
  await SecureStore.deleteItemAsync(DEVICE_SECRET_KEY);
  console.log('[Crypto] Cleared device secret');
}
