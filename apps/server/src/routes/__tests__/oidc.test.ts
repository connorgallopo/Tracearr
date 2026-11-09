/**
 * OIDC sign-in gating tests
 *
 * Covers GET /setup/status reporting authMethods.oidc based on the OIDC_*
 * env vars. Plugin registration and config-shape assertions for the
 * genericOAuth plugin live in lib/__tests__/auth.test.ts (unmocked
 * construction); the shared single-owner signup gate is covered live in
 * test/integration/betterAuthSignup.integration.test.ts and
 * betterAuthSecurity.integration.test.ts.
 *
 * The OIDC claim-code gate (auth.ts hooks.before, '/sign-in/social') delegates
 * to authGuards.assertOAuthSignupClaimCode. Driving it through a real request
 * would hit Better Auth's rate-limiter (needs live Redis, unavailable here),
 * so this exercises that guard directly instead.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

function clearOidcEnv() {
  delete process.env.OIDC_ISSUER_URL;
  delete process.env.OIDC_CLIENT_ID;
  delete process.env.OIDC_CLIENT_SECRET;
  delete process.env.OIDC_PROVIDER_NAME;
}

describe('oidc gating', () => {
  beforeEach(() => {
    clearOidcEnv();
    vi.resetModules();
  });

  afterEach(() => {
    clearOidcEnv();
    vi.resetModules();
  });

  describe('GET /setup/status authMethods', () => {
    async function buildApp(): Promise<FastifyInstance> {
      vi.doMock('../../db/client.js', () => ({ db: { select: vi.fn() } }));
      vi.doMock('../../utils/claimCode.js', () => ({
        isClaimCodeEnabled: vi.fn().mockReturnValue(false),
      }));
      const { db } = await import('../../db/client.js');
      const emptyChain = () => ({
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue([]),
      });
      vi.mocked(db.select).mockImplementation(() => emptyChain() as never);

      const { setupRoutes } = await import('../setup.js');
      const app = Fastify({ logger: false });
      await app.register(setupRoutes, { prefix: '/setup' });
      return app;
    }

    it('reports oidc disabled when env is absent', async () => {
      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(res.statusCode).toBe(200);
      expect(res.json().authMethods).toEqual({
        local: true,
        plex: true,
        oidc: false,
        oidcProviderName: null,
        member: false,
        ssoOnly: false,
      });

      await app.close();
    });

    it('reports oidc enabled with the configured provider name', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'test-client';
      process.env.OIDC_CLIENT_SECRET = 'test-secret';
      process.env.OIDC_PROVIDER_NAME = 'Authentik';

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(res.statusCode).toBe(200);
      expect(res.json().authMethods).toEqual({
        local: true,
        plex: true,
        oidc: true,
        oidcProviderName: 'Authentik',
        member: false,
        ssoOnly: false,
      });

      await app.close();
    });

    it('falls back to "SSO" when OIDC_PROVIDER_NAME is not set', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'test-client';
      process.env.OIDC_CLIENT_SECRET = 'test-secret';

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(res.json().authMethods.oidcProviderName).toBe('SSO');

      await app.close();
    });

    it('stays disabled when only some of the required env vars are set', async () => {
      process.env.OIDC_ISSUER_URL = 'https://auth.example.com';
      process.env.OIDC_CLIENT_ID = 'test-client';
      // OIDC_CLIENT_SECRET intentionally omitted

      const app = await buildApp();
      const res = await app.inject({ method: 'GET', url: '/setup/status' });

      expect(res.json().authMethods).toEqual({
        local: true,
        plex: true,
        oidc: false,
        oidcProviderName: null,
        member: false,
        ssoOnly: false,
      });

      await app.close();
    });
  });

  describe('OIDC signup claim-code gate (auth.ts hooks.before -> assertOAuthSignupClaimCode)', () => {
    async function loadGuard() {
      vi.doMock('../../services/userService.js', () => ({ getOwnerUser: vi.fn() }));
      vi.doMock('../../utils/claimCode.js', () => ({
        isClaimCodeEnabled: vi.fn(),
        validateClaimCode: vi.fn(),
      }));
      const { getOwnerUser } = await import('../../services/userService.js');
      const { isClaimCodeEnabled, validateClaimCode } = await import('../../utils/claimCode.js');
      const { assertOAuthSignupClaimCode } = await import('../../lib/authGuards.js');
      return {
        assertOAuthSignupClaimCode,
        getOwnerUser: vi.mocked(getOwnerUser),
        isClaimCodeEnabled: vi.mocked(isClaimCodeEnabled),
        validateClaimCode: vi.mocked(validateClaimCode),
      };
    }

    it('rejects OIDC-initiated signup with no claim code on an ownerless instance with CLAIM_CODE set', async () => {
      const guard = await loadGuard();
      guard.getOwnerUser.mockResolvedValue(null);
      guard.isClaimCodeEnabled.mockReturnValue(true);

      await expect(guard.assertOAuthSignupClaimCode(undefined)).rejects.toMatchObject({
        status: 'FORBIDDEN',
      });
    });

    it('rejects OIDC-initiated signup with a wrong claim code on an ownerless instance', async () => {
      const guard = await loadGuard();
      guard.getOwnerUser.mockResolvedValue(null);
      guard.isClaimCodeEnabled.mockReturnValue(true);
      guard.validateClaimCode.mockReturnValue(false);

      await expect(guard.assertOAuthSignupClaimCode('nope')).rejects.toMatchObject({
        status: 'FORBIDDEN',
      });
    });

    it('allows OIDC sign-in on an already-owned instance without a claim code', async () => {
      const guard = await loadGuard();
      guard.getOwnerUser.mockResolvedValue({ id: 'owner-id', role: 'owner' } as never);

      await expect(guard.assertOAuthSignupClaimCode(undefined)).resolves.toBeUndefined();
      expect(guard.isClaimCodeEnabled).not.toHaveBeenCalled();
    });
  });
});
