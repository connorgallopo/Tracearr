/**
 * Authentication Helpers for Testing
 *
 * Utilities for generating test JWTs and auth tokens.
 */

import jwt from 'jsonwebtoken';

const TEST_JWT_SECRET = 'test-jwt-secret-for-testing-only';

export interface TestTokenPayload {
  sub: string;
  role: 'owner' | 'admin' | 'member';
  email?: string;
  name?: string;
  iat?: number;
  exp?: number;
}

export interface GenerateTokenOptions {
  userId: string;
  role?: 'owner' | 'admin' | 'member';
  email?: string;
  name?: string;
  expiresIn?: string | number;
  secret?: string;
}

/**
 * Generate a test JWT token
 */
export function generateTestToken(options: GenerateTokenOptions): string {
  const {
    userId,
    role = 'owner',
    email,
    name,
    expiresIn = '1h',
    secret = TEST_JWT_SECRET,
  } = options;

  const payload: TestTokenPayload = {
    sub: userId,
    role,
  };

  if (email) payload.email = email;
  if (name) payload.name = name;

  return jwt.sign(payload, secret, { expiresIn: expiresIn as jwt.SignOptions['expiresIn'] });
}

/**
 * Generate an expired token for testing auth rejection
 */
export function generateExpiredToken(options: Omit<GenerateTokenOptions, 'expiresIn'>): string {
  const { userId, role = 'owner', email, name, secret = TEST_JWT_SECRET } = options;

  const payload: TestTokenPayload = {
    sub: userId,
    role,
    iat: Math.floor(Date.now() / 1000) - 7200, // 2 hours ago
    exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
  };

  if (email) payload.email = email;
  if (name) payload.name = name;

  // Use direct sign to bypass expiration check
  return jwt.sign(payload, secret, { noTimestamp: true });
}

/**
 * Generate a token with invalid signature
 */
export function generateInvalidToken(options: GenerateTokenOptions): string {
  const token = generateTestToken(options);
  // Corrupt the signature by replacing last character
  return token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
}

/**
 * Decode a token without verification (for test assertions)
 */
export function decodeToken(token: string): TestTokenPayload | null {
  try {
    const decoded = jwt.decode(token) as TestTokenPayload;
    return decoded;
  } catch {
    return null;
  }
}

/**
 * Verify a token with test secret
 */
export function verifyTestToken(token: string, secret = TEST_JWT_SECRET): TestTokenPayload | null {
  try {
    return jwt.verify(token, secret) as TestTokenPayload;
  } catch {
    return null;
  }
}

/**
 * Generate an owner token (convenience helper)
 */
export function generateOwnerToken(userId: string, name = 'Test Owner'): string {
  return generateTestToken({ userId, role: 'owner', name });
}

/**
 * Generate an admin token (convenience helper)
 */
export function generateAdminToken(userId: string, name = 'Test Admin'): string {
  return generateTestToken({ userId, role: 'admin', name });
}

/**
 * Generate a member token (convenience helper)
 */
export function generateMemberToken(userId: string, name = 'Test Member'): string {
  return generateTestToken({ userId, role: 'member', name });
}

/**
 * Create auth headers for test requests
 */
export function authHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
  };
}

/**
 * Create auth headers with owner token
 */
export function ownerAuthHeaders(userId: string): Record<string, string> {
  return authHeaders(generateOwnerToken(userId));
}

/**
 * Create auth headers with admin token
 */
export function adminAuthHeaders(userId: string): Record<string, string> {
  return authHeaders(generateAdminToken(userId));
}

/**
 * Create auth headers with member token
 */
export function memberAuthHeaders(userId: string): Record<string, string> {
  return authHeaders(generateMemberToken(userId));
}

/**
 * Get the test JWT secret (for configuring test server)
 */
export function getTestJwtSecret(): string {
  return TEST_JWT_SECRET;
}

/**
 * Generate a mobile pairing token
 */
export function generateMobilePairingToken(length = 32): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let result = 'trr_mob_';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

/**
 * Generate a QR code pairing payload
 */
export function generateQRPairingPayload(options: {
  token: string;
  serverUrl: string;
  userId: string;
  expiresAt?: Date;
}): string {
  const payload = {
    token: options.token,
    serverUrl: options.serverUrl,
    userId: options.userId,
    expiresAt: (options.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000)).toISOString(),
  };
  return `tracearr://pair?data=${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}
