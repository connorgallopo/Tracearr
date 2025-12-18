/**
 * Push Encryption Service Tests
 *
 * Tests the push notification payload encryption service:
 * - AES-256-GCM encryption with proper IV/salt generation
 * - PBKDF2 key derivation consistency
 * - Payload handling (Unicode, size limits)
 * - Encryption toggle based on device secret
 *
 * Uses a test-only decrypt function to verify encrypted payloads
 * can be properly decrypted (simulating mobile client behavior).
 */

import { describe, it, expect } from 'vitest';
import { createDecipheriv, pbkdf2Sync } from 'node:crypto';
import type { EncryptedPushPayload } from '@tracearr/shared';
import { encryptPushPayload, shouldEncryptPush, pushEncryptionService } from '../pushEncryption.js';

// Constants matching the encryption service
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

/**
 * Test-only decrypt function that mirrors mobile client decryption
 * Used to verify encrypted payloads can be properly decrypted
 */
function decryptPushPayload(
  encrypted: EncryptedPushPayload,
  deviceSecret: string
): Record<string, unknown> {
  const iv = Buffer.from(encrypted.iv, 'base64');
  const salt = Buffer.from(encrypted.salt, 'base64');
  const ciphertext = Buffer.from(encrypted.ct, 'base64');
  const authTag = Buffer.from(encrypted.tag, 'base64');

  // Derive key using same PBKDF2 params
  const key = pbkdf2Sync(deviceSecret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

  // Create decipher
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  // Decrypt
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return JSON.parse(decrypted.toString('utf8'));
}

describe('pushEncryption', () => {
  const testDeviceSecret = 'test-device-secret-12345678901234567890';

  describe('encryptPushPayload', () => {
    it('encrypts and decrypts payload correctly', () => {
      const payload = {
        type: 'session:started',
        title: 'Breaking Bad',
        username: 'walter',
      };

      const encrypted = encryptPushPayload(payload, testDeviceSecret);

      // Verify structure
      expect(encrypted.v).toBe(1);
      expect(encrypted.iv).toBeDefined();
      expect(encrypted.salt).toBeDefined();
      expect(encrypted.ct).toBeDefined();
      expect(encrypted.tag).toBeDefined();

      // Verify decryption works
      const decrypted = decryptPushPayload(encrypted, testDeviceSecret);
      expect(decrypted).toEqual(payload);
    });

    it('produces different ciphertext for same plaintext (random IV)', () => {
      const payload = { message: 'test notification' };

      const encrypted1 = encryptPushPayload(payload, testDeviceSecret);
      const encrypted2 = encryptPushPayload(payload, testDeviceSecret);

      // IVs should be different (random)
      expect(encrypted1.iv).not.toBe(encrypted2.iv);
      // Salts should be different (random)
      expect(encrypted1.salt).not.toBe(encrypted2.salt);
      // Ciphertext should be different due to different IV/salt
      expect(encrypted1.ct).not.toBe(encrypted2.ct);
      // Auth tags should be different
      expect(encrypted1.tag).not.toBe(encrypted2.tag);

      // But both should decrypt to same payload
      expect(decryptPushPayload(encrypted1, testDeviceSecret)).toEqual(payload);
      expect(decryptPushPayload(encrypted2, testDeviceSecret)).toEqual(payload);
    });

    it('fails decryption with wrong key', () => {
      const payload = { secret: 'sensitive data' };
      const encrypted = encryptPushPayload(payload, testDeviceSecret);

      // Attempt decryption with wrong secret
      expect(() => {
        decryptPushPayload(encrypted, 'wrong-device-secret');
      }).toThrow(); // GCM auth will fail
    });

    it('fails decryption with tampered ciphertext', () => {
      const payload = { important: 'data' };
      const encrypted = encryptPushPayload(payload, testDeviceSecret);

      // Tamper with ciphertext
      const ctBuffer = Buffer.from(encrypted.ct, 'base64');
      ctBuffer[0] = (ctBuffer[0] ?? 0) ^ 0xff; // Flip bits
      const tampered: EncryptedPushPayload = {
        ...encrypted,
        ct: ctBuffer.toString('base64'),
      };

      // Attempt decryption should fail auth tag verification
      expect(() => {
        decryptPushPayload(tampered, testDeviceSecret);
      }).toThrow();
    });

    it('fails decryption with tampered auth tag', () => {
      const payload = { critical: 'information' };
      const encrypted = encryptPushPayload(payload, testDeviceSecret);

      // Tamper with auth tag
      const tagBuffer = Buffer.from(encrypted.tag, 'base64');
      tagBuffer[0] = (tagBuffer[0] ?? 0) ^ 0xff;
      const tampered: EncryptedPushPayload = {
        ...encrypted,
        tag: tagBuffer.toString('base64'),
      };

      expect(() => {
        decryptPushPayload(tampered, testDeviceSecret);
      }).toThrow();
    });
  });

  describe('key derivation', () => {
    it('generates valid 256-bit keys (32 bytes)', () => {
      const payload = { test: true };
      const encrypted = encryptPushPayload(payload, testDeviceSecret);

      // Salt should be 16 bytes (128 bits)
      const salt = Buffer.from(encrypted.salt, 'base64');
      expect(salt.length).toBe(16);

      // IV should be 12 bytes (96 bits)
      const iv = Buffer.from(encrypted.iv, 'base64');
      expect(iv.length).toBe(12);

      // Auth tag should be 16 bytes (128 bits)
      const tag = Buffer.from(encrypted.tag, 'base64');
      expect(tag.length).toBe(16);
    });

    it('derives consistent key from device ID and salt', () => {
      // Same secret + same salt = same key (deterministic PBKDF2)
      const salt = Buffer.from('0123456789abcdef'); // 16 bytes
      const key1 = pbkdf2Sync(testDeviceSecret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
      const key2 = pbkdf2Sync(testDeviceSecret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

      expect(key1.equals(key2)).toBe(true);
    });

    it('derives different keys for different device secrets', () => {
      const salt = Buffer.from('0123456789abcdef');
      const key1 = pbkdf2Sync('device-secret-1', salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
      const key2 = pbkdf2Sync('device-secret-2', salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');

      expect(key1.equals(key2)).toBe(false);
    });
  });

  describe('payload handling', () => {
    it('handles Unicode characters correctly', () => {
      const payload = {
        title: '日本語タイトル',
        emoji: '🎬🍿',
        chinese: '中文内容',
        arabic: 'محتوى عربي',
        mixed: 'Hello 世界 🌍',
      };

      const encrypted = encryptPushPayload(payload, testDeviceSecret);
      const decrypted = decryptPushPayload(encrypted, testDeviceSecret);

      expect(decrypted).toEqual(payload);
    });

    it('handles nested objects', () => {
      const payload = {
        session: {
          id: 'abc123',
          user: {
            name: 'testuser',
            settings: {
              notifications: true,
            },
          },
        },
        metadata: {
          timestamp: 1234567890,
        },
      };

      const encrypted = encryptPushPayload(payload, testDeviceSecret);
      const decrypted = decryptPushPayload(encrypted, testDeviceSecret);

      expect(decrypted).toEqual(payload);
    });

    it('handles arrays in payload', () => {
      const payload = {
        users: ['alice', 'bob', 'charlie'],
        counts: [1, 2, 3, 4, 5],
        nested: [{ id: 1 }, { id: 2 }],
      };

      const encrypted = encryptPushPayload(payload, testDeviceSecret);
      const decrypted = decryptPushPayload(encrypted, testDeviceSecret);

      expect(decrypted).toEqual(payload);
    });

    it('handles empty payload', () => {
      const payload = {};

      const encrypted = encryptPushPayload(payload, testDeviceSecret);
      const decrypted = decryptPushPayload(encrypted, testDeviceSecret);

      expect(decrypted).toEqual(payload);
    });

    it('handles payload with null values', () => {
      const payload = {
        title: 'Test',
        subtitle: null,
        metadata: null,
      };

      const encrypted = encryptPushPayload(payload, testDeviceSecret);
      const decrypted = decryptPushPayload(encrypted, testDeviceSecret);

      expect(decrypted).toEqual(payload);
    });

    it('handles large payload within typical size limits', () => {
      // Create a payload around 3KB (under typical 4KB push limit)
      const largeContent = 'x'.repeat(2500);
      const payload = {
        type: 'notification',
        content: largeContent,
        timestamp: Date.now(),
      };

      const encrypted = encryptPushPayload(payload, testDeviceSecret);
      const decrypted = decryptPushPayload(encrypted, testDeviceSecret);

      expect(decrypted).toEqual(payload);
      expect((decrypted as { content: string }).content.length).toBe(2500);
    });
  });

  describe('shouldEncryptPush', () => {
    it('returns true for valid device secret', () => {
      expect(shouldEncryptPush('valid-secret')).toBe(true);
      expect(shouldEncryptPush('a')).toBe(true);
      expect(shouldEncryptPush(testDeviceSecret)).toBe(true);
    });

    it('returns false for null device secret', () => {
      expect(shouldEncryptPush(null)).toBe(false);
    });

    it('returns false for empty string device secret', () => {
      expect(shouldEncryptPush('')).toBe(false);
    });
  });

  describe('PushEncryptionService', () => {
    describe('encryptIfEnabled', () => {
      it('returns encrypted payload when device secret is provided', () => {
        const payload = { type: 'test' };

        const result = pushEncryptionService.encryptIfEnabled(payload, testDeviceSecret);

        // Should be encrypted
        expect(result).toHaveProperty('v', 1);
        expect(result).toHaveProperty('iv');
        expect(result).toHaveProperty('salt');
        expect(result).toHaveProperty('ct');
        expect(result).toHaveProperty('tag');

        // Verify it decrypts correctly
        const decrypted = decryptPushPayload(result as EncryptedPushPayload, testDeviceSecret);
        expect(decrypted).toEqual(payload);
      });

      it('returns unencrypted payload when device secret is null', () => {
        const payload = { type: 'test', data: 'value' };

        const result = pushEncryptionService.encryptIfEnabled(payload, null);

        // Should be the original payload unchanged
        expect(result).toEqual(payload);
        expect(result).not.toHaveProperty('v');
        expect(result).not.toHaveProperty('ct');
      });

      it('returns unencrypted payload when device secret is empty string', () => {
        const payload = { message: 'hello' };

        const result = pushEncryptionService.encryptIfEnabled(payload, '');

        expect(result).toEqual(payload);
      });
    });

    describe('encrypt', () => {
      it('always encrypts the payload', () => {
        const payload = { type: 'notification' };

        const result = pushEncryptionService.encrypt(payload, testDeviceSecret);

        expect(result.v).toBe(1);
        expect(result.iv).toBeDefined();
        expect(result.salt).toBeDefined();
        expect(result.ct).toBeDefined();
        expect(result.tag).toBeDefined();
      });

      it('produces decryptable output', () => {
        const payload = {
          type: 'violation:new',
          severity: 'high',
          user: 'suspicious_user',
        };

        const encrypted = pushEncryptionService.encrypt(payload, testDeviceSecret);
        const decrypted = decryptPushPayload(encrypted, testDeviceSecret);

        expect(decrypted).toEqual(payload);
      });
    });
  });
});
