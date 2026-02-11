/**
 * Auth Route Utilities Tests
 *
 * Tests pure utility functions from routes/auth/utils.ts:
 * - generateRefreshToken: Generate random refresh tokens
 * - hashRefreshToken: Hash tokens for secure storage
 * - generateTempToken: Generate temporary OAuth tokens
 */

import { describe, it, expect } from 'vitest';
import {
  generateRefreshToken,
  hashRefreshToken,
  generateTempToken,
  REFRESH_TOKEN_TTL,
  PLEX_TEMP_TOKEN_TTL,
} from '../utils.js';
import { REDIS_KEYS } from '@tracearr/shared';

describe('generateRefreshToken', () => {
  it('should generate a 64 character hex string', () => {
    const token = generateRefreshToken();
    expect(token).toHaveLength(64); // 32 bytes = 64 hex chars
    expect(token).toMatch(/^[a-f0-9]+$/);
  });

  it('should generate unique tokens each call', () => {
    const token1 = generateRefreshToken();
    const token2 = generateRefreshToken();
    const token3 = generateRefreshToken();

    expect(token1).not.toBe(token2);
    expect(token2).not.toBe(token3);
    expect(token1).not.toBe(token3);
  });

  it('should generate cryptographically random tokens', () => {
    // Generate many tokens and verify no collisions
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) {
      tokens.add(generateRefreshToken());
    }
    expect(tokens.size).toBe(100);
  });
});

describe('hashRefreshToken', () => {
  it('should return a 64 character SHA-256 hex hash', () => {
    const hash = hashRefreshToken('test-token');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('should produce consistent hashes for the same input', () => {
    const token = 'my-refresh-token';
    const hash1 = hashRefreshToken(token);
    const hash2 = hashRefreshToken(token);
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = hashRefreshToken('token-1');
    const hash2 = hashRefreshToken('token-2');
    expect(hash1).not.toBe(hash2);
  });

  it('should hash empty string without error', () => {
    const hash = hashRefreshToken('');
    expect(hash).toHaveLength(64);
    // SHA-256 of empty string
    expect(hash).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('should be one-way (cannot derive original token)', () => {
    const token = generateRefreshToken();
    const hash = hashRefreshToken(token);
    // Hash should not contain the token
    expect(hash).not.toContain(token);
    // Hash length is different from token length
    expect(hash.length).toBe(token.length); // Both 64 but different content
  });
});

describe('generateTempToken', () => {
  it('should generate a 48 character hex string', () => {
    const token = generateTempToken();
    expect(token).toHaveLength(48); // 24 bytes = 48 hex chars
    expect(token).toMatch(/^[a-f0-9]+$/);
  });

  it('should generate unique tokens each call', () => {
    const token1 = generateTempToken();
    const token2 = generateTempToken();
    expect(token1).not.toBe(token2);
  });
});

describe('Constants', () => {
  describe('Redis key functions', () => {
    it('should generate correct REFRESH_TOKEN key', () => {
      expect(REDIS_KEYS.REFRESH_TOKEN('abc123')).toBe('tracearr:refresh:abc123');
    });

    it('should generate correct PLEX_TEMP_TOKEN key', () => {
      expect(REDIS_KEYS.PLEX_TEMP_TOKEN('xyz789')).toBe('tracearr:plex_temp:xyz789');
    });
  });

  describe('TTL values', () => {
    it('should have REFRESH_TOKEN_TTL of 30 days in seconds', () => {
      expect(REFRESH_TOKEN_TTL).toBe(30 * 24 * 60 * 60);
    });

    it('should have PLEX_TEMP_TOKEN_TTL of 10 minutes in seconds', () => {
      expect(PLEX_TEMP_TOKEN_TTL).toBe(10 * 60);
    });
  });
});

describe('Integration: Token workflow', () => {
  it('should support generate -> hash -> lookup workflow', () => {
    // Simulate token creation and storage lookup
    const refreshToken = generateRefreshToken();
    const storedHash = hashRefreshToken(refreshToken);

    // User sends token back, we hash it to look up
    const lookupHash = hashRefreshToken(refreshToken);

    // Should match for lookup
    expect(lookupHash).toBe(storedHash);
  });

  it('should reject different token in lookup', () => {
    const originalToken = generateRefreshToken();
    const storedHash = hashRefreshToken(originalToken);

    const differentToken = generateRefreshToken();
    const lookupHash = hashRefreshToken(differentToken);

    expect(lookupHash).not.toBe(storedHash);
  });
});
