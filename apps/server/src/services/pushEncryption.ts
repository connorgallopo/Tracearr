/**
 * Push Notification Payload Encryption Service
 *
 * Encrypts push notification payloads using AES-256-GCM for secure
 * transmission to mobile devices. Each device has a unique secret
 * that's used for key derivation, ensuring only that device can
 * decrypt the payload.
 *
 * Security properties:
 * - AES-256-GCM provides confidentiality and integrity
 * - PBKDF2 key derivation with 100,000 iterations
 * - Per-device secrets ensure isolation
 * - Random IVs for each message prevent replay attacks
 */

import { createCipheriv, randomBytes, pbkdf2Sync } from 'node:crypto';
import type { EncryptedPushPayload } from '@tracearr/shared';

// AES-256-GCM parameters (must match mobile client)
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits (recommended for GCM)
const SALT_LENGTH = 16; // 128 bits (NIST recommended minimum)
const _AUTH_TAG_LENGTH = 16; // 128 bits
const PBKDF2_ITERATIONS = 100000;

/**
 * Derive encryption key using PBKDF2
 * Uses the same parameters as the mobile client for compatibility
 */
function deriveKey(deviceSecret: string, salt: Buffer): Buffer {
  return pbkdf2Sync(deviceSecret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
}

/**
 * Encrypt a push notification payload for a specific device
 *
 * @param payload - The notification payload to encrypt
 * @param deviceSecret - The device's unique secret (stored in mobile_sessions)
 * @returns Encrypted payload in EncryptedPushPayload format
 */
export function encryptPushPayload(
  payload: Record<string, unknown>,
  deviceSecret: string
): EncryptedPushPayload {
  // Generate random IV and salt separately (NIST: salt should be at least 128 bits)
  const iv = randomBytes(IV_LENGTH);
  const salt = randomBytes(SALT_LENGTH);

  // Derive key using proper random salt
  const key = deriveKey(deviceSecret, salt);

  // Create cipher
  const cipher = createCipheriv(ALGORITHM, key, iv);

  // Encrypt payload
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // Get authentication tag
  const authTag = cipher.getAuthTag();

  return {
    v: 1,
    iv: iv.toString('base64'),
    salt: salt.toString('base64'),
    ct: encrypted.toString('base64'),
    tag: authTag.toString('base64'),
  };
}

/**
 * Check if encryption should be enabled for a push notification
 *
 * @param deviceSecret - The device's secret (if available)
 * @returns true if encryption should be used
 */
export function shouldEncryptPush(deviceSecret: string | null): boolean {
  return deviceSecret !== null && deviceSecret.length > 0;
}

/**
 * Push Encryption Service
 * Provides encryption capabilities for push notification payloads
 */
export class PushEncryptionService {
  /**
   * Encrypt payload if device has a secret, otherwise return unencrypted
   *
   * @param payload - Original notification payload
   * @param deviceSecret - Device's encryption secret (null = no encryption)
   * @returns Encrypted payload or original payload
   * @throws Error if encryption is required but fails
   */
  encryptIfEnabled(
    payload: Record<string, unknown>,
    deviceSecret: string | null
  ): Record<string, unknown> | EncryptedPushPayload {
    if (!shouldEncryptPush(deviceSecret)) {
      // No encryption configured - return unencrypted (expected for devices without secrets)
      return payload;
    }

    // Encryption is required - do not silently fallback to unencrypted on failure
    return encryptPushPayload(payload, deviceSecret!);
  }

  /**
   * Encrypt payload for a device (throws if encryption fails)
   *
   * @param payload - Original notification payload
   * @param deviceSecret - Device's encryption secret
   * @returns Encrypted payload
   * @throws Error if encryption fails
   */
  encrypt(payload: Record<string, unknown>, deviceSecret: string): EncryptedPushPayload {
    return encryptPushPayload(payload, deviceSecret);
  }
}

// Export singleton instance
export const pushEncryptionService = new PushEncryptionService();
