/**
 * Notification Preferences routes tests
 *
 * Tests the API endpoints for mobile notification preferences:
 * - GET /notifications/preferences - Get preferences for current device
 * - PATCH /notifications/preferences - Update preferences for current device
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import sensible from '@fastify/sensible';
import { randomUUID } from 'node:crypto';

// Define mobile auth user type
interface MobileAuthUser {
  userId: string;
  deviceId?: string;
  role: 'owner' | 'guest';
}

// Mock the database module before importing routes
vi.mock('../../db/client.js', () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
  },
}));

// Mock the push rate limiter
vi.mock('../../services/pushRateLimiter.js', () => ({
  getPushRateLimiter: vi.fn(),
}));

// Import mocked modules
import { db } from '../../db/client.js';
import { getPushRateLimiter } from '../../services/pushRateLimiter.js';
import { notificationPreferencesRoutes } from '../notificationPreferences.js';

// Helper to create DB chain mocks
function mockDbSelectLimit(result: unknown[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.select).mockReturnValue(chain as never);
  return chain;
}

function mockDbInsert(result: unknown[]) {
  const chain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue(result),
  };
  vi.mocked(db.insert).mockReturnValue(chain as never);
  return chain;
}

function mockDbUpdate() {
  const chain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(db.update).mockReturnValue(chain as never);
  return chain;
}

async function buildTestApp(mobileUser: MobileAuthUser): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(sensible);

  // Mock requireMobile middleware
  app.decorate('requireMobile', async (request: unknown) => {
    (request as { user: MobileAuthUser }).user = mobileUser;
  });

  await app.register(notificationPreferencesRoutes, { prefix: '/notifications' });
  return app;
}

const mobileSessionId = randomUUID();
const deviceId = randomUUID();

const mobileUser: MobileAuthUser = {
  userId: randomUUID(),
  deviceId: deviceId,
  role: 'owner',
};

const mockMobileSession = {
  id: mobileSessionId,
  deviceId: deviceId,
  deviceName: 'Test iPhone',
  expoPushToken: 'ExponentPushToken[xxx]',
  lastSeenAt: new Date(),
};

const mockPrefsRow = {
  id: randomUUID(),
  mobileSessionId: mobileSessionId,
  pushEnabled: true,
  onViolationDetected: true,
  onStreamStarted: false,
  onStreamStopped: false,
  onConcurrentStreams: true,
  onNewDevice: true,
  onTrustScoreChanged: false,
  onServerDown: true,
  onServerUp: true,
  violationMinSeverity: 1,
  violationRuleTypes: ['impossible_travel', 'concurrent_streams'],
  maxPerMinute: 5,
  maxPerHour: 50,
  quietHoursEnabled: false,
  quietHoursStart: null,
  quietHoursEnd: null,
  quietHoursTimezone: 'UTC',
  quietHoursOverrideCritical: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe('Notification Preferences Routes', () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
    vi.clearAllMocks();
  });

  describe('GET /notifications/preferences', () => {
    it('returns existing preferences for mobile user with deviceId', async () => {
      app = await buildTestApp(mobileUser);

      // Mock: find mobile session by deviceId, then find preferences
      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [{ id: mockMobileSession.id }] // Mobile session found
              : [mockPrefsRow] // Preferences found
          ),
        };
        return chain as never;
      });

      // No rate limiter
      vi.mocked(getPushRateLimiter).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/notifications/preferences',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.pushEnabled).toBe(true);
      expect(body.onViolationDetected).toBe(true);
      expect(body.maxPerMinute).toBe(5);
      expect(body.violationRuleTypes).toEqual(['impossible_travel', 'concurrent_streams']);
    });

    it('includes rate limit status when rate limiter is available', async () => {
      app = await buildTestApp(mobileUser);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi
            .fn()
            .mockResolvedValue(selectCount === 1 ? [{ id: mockMobileSession.id }] : [mockPrefsRow]),
        };
        return chain as never;
      });

      // Mock rate limiter with status
      const mockRateLimiter = {
        getStatus: vi.fn().mockResolvedValue({
          remainingMinute: 3,
          remainingHour: 45,
          resetMinuteIn: 30,
          resetHourIn: 1800,
        }),
      };
      vi.mocked(getPushRateLimiter).mockReturnValue(mockRateLimiter as never);

      const response = await app.inject({
        method: 'GET',
        url: '/notifications/preferences',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.rateLimitStatus).toBeDefined();
      expect(body.rateLimitStatus.remainingMinute).toBe(3);
      expect(body.rateLimitStatus.remainingHour).toBe(45);
    });

    it('creates default preferences if none exist', async () => {
      app = await buildTestApp(mobileUser);

      const defaultPrefs = {
        ...mockPrefsRow,
        pushEnabled: true,
        onViolationDetected: true,
        onStreamStarted: false,
        onStreamStopped: false,
      };

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [{ id: mockMobileSession.id }] // Mobile session found
              : [] // No preferences yet
          ),
        };
        return chain as never;
      });

      mockDbInsert([defaultPrefs]);
      vi.mocked(getPushRateLimiter).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/notifications/preferences',
      });

      expect(response.statusCode).toBe(200);
      expect(db.insert).toHaveBeenCalled();
    });

    it('falls back to user lookup when deviceId not provided', async () => {
      const userWithoutDeviceId: MobileAuthUser = {
        userId: randomUUID(),
        // No deviceId
        role: 'owner',
      };
      app = await buildTestApp(userWithoutDeviceId);

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [{ id: mockMobileSession.id }] // Fallback finds session
              : [mockPrefsRow]
          ),
        };
        return chain as never;
      });

      vi.mocked(getPushRateLimiter).mockReturnValue(null);

      const response = await app.inject({
        method: 'GET',
        url: '/notifications/preferences',
      });

      expect(response.statusCode).toBe(200);
    });

    it('returns 404 when no mobile session found', async () => {
      app = await buildTestApp(mobileUser);

      mockDbSelectLimit([]); // No mobile session

      const response = await app.inject({
        method: 'GET',
        url: '/notifications/preferences',
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().message).toContain('No mobile session');
    });
  });

  describe('PATCH /notifications/preferences', () => {
    it('updates preferences for mobile user', async () => {
      app = await buildTestApp(mobileUser);

      const updatedPrefs = {
        ...mockPrefsRow,
        pushEnabled: false,
        onStreamStarted: true,
      };

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [{ id: mockMobileSession.id }] // Mobile session found
              : selectCount === 2
                ? [mockPrefsRow] // Existing prefs found
                : [updatedPrefs] // Updated prefs returned
          ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          pushEnabled: false,
          onStreamStarted: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(db.update).toHaveBeenCalled();
      const body = response.json();
      expect(body.pushEnabled).toBe(false);
      expect(body.onStreamStarted).toBe(true);
    });

    it('updates all notification event preferences', async () => {
      app = await buildTestApp(mobileUser);

      const updatedPrefs = {
        ...mockPrefsRow,
        onViolationDetected: false,
        onConcurrentStreams: false,
        onNewDevice: false,
        onTrustScoreChanged: true,
        onServerDown: false,
        onServerUp: false,
      };

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi
            .fn()
            .mockResolvedValue(
              selectCount === 1
                ? [{ id: mockMobileSession.id }]
                : selectCount === 2
                  ? [mockPrefsRow]
                  : [updatedPrefs]
            ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          onViolationDetected: false,
          onConcurrentStreams: false,
          onNewDevice: false,
          onTrustScoreChanged: true,
          onServerDown: false,
          onServerUp: false,
        },
      });

      expect(response.statusCode).toBe(200);
    });

    it('updates rate limit settings', async () => {
      app = await buildTestApp(mobileUser);

      const updatedPrefs = {
        ...mockPrefsRow,
        maxPerMinute: 10,
        maxPerHour: 100,
      };

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi
            .fn()
            .mockResolvedValue(
              selectCount === 1
                ? [{ id: mockMobileSession.id }]
                : selectCount === 2
                  ? [mockPrefsRow]
                  : [updatedPrefs]
            ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          maxPerMinute: 10,
          maxPerHour: 100,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.maxPerMinute).toBe(10);
      expect(body.maxPerHour).toBe(100);
    });

    it('updates quiet hours settings', async () => {
      app = await buildTestApp(mobileUser);

      const updatedPrefs = {
        ...mockPrefsRow,
        quietHoursEnabled: true,
        quietHoursStart: '22:00',
        quietHoursEnd: '07:00',
        quietHoursTimezone: 'America/New_York',
        quietHoursOverrideCritical: false,
      };

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi
            .fn()
            .mockResolvedValue(
              selectCount === 1
                ? [{ id: mockMobileSession.id }]
                : selectCount === 2
                  ? [mockPrefsRow]
                  : [updatedPrefs]
            ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          quietHoursEnabled: true,
          quietHoursStart: '22:00',
          quietHoursEnd: '07:00',
          quietHoursTimezone: 'America/New_York',
          quietHoursOverrideCritical: false,
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.quietHoursEnabled).toBe(true);
      expect(body.quietHoursStart).toBe('22:00');
      expect(body.quietHoursEnd).toBe('07:00');
    });

    it('updates violation filter settings', async () => {
      app = await buildTestApp(mobileUser);

      const updatedPrefs = {
        ...mockPrefsRow,
        violationMinSeverity: 2,
        violationRuleTypes: ['geo_restriction'],
      };

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi
            .fn()
            .mockResolvedValue(
              selectCount === 1
                ? [{ id: mockMobileSession.id }]
                : selectCount === 2
                  ? [mockPrefsRow]
                  : [updatedPrefs]
            ),
        };
        return chain as never;
      });
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          violationMinSeverity: 2,
          violationRuleTypes: ['geo_restriction'],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.violationMinSeverity).toBe(2);
      expect(body.violationRuleTypes).toEqual(['geo_restriction']);
    });

    it('creates preferences if they do not exist', async () => {
      app = await buildTestApp(mobileUser);

      const newPrefs = {
        ...mockPrefsRow,
        pushEnabled: false,
      };

      let selectCount = 0;
      vi.mocked(db.select).mockImplementation(() => {
        selectCount++;
        const chain = {
          from: vi.fn().mockReturnThis(),
          where: vi.fn().mockReturnThis(),
          orderBy: vi.fn().mockReturnThis(),
          limit: vi.fn().mockResolvedValue(
            selectCount === 1
              ? [{ id: mockMobileSession.id }] // Mobile session found
              : selectCount === 2
                ? [] // No existing prefs
                : [newPrefs] // After update
          ),
        };
        return chain as never;
      });

      mockDbInsert([mockPrefsRow]); // Insert creates defaults
      mockDbUpdate();

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          pushEnabled: false,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(db.insert).toHaveBeenCalled();
    });

    it('returns 404 when no mobile session found', async () => {
      app = await buildTestApp(mobileUser);

      mockDbSelectLimit([]); // No mobile session

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          pushEnabled: true,
        },
      });

      expect(response.statusCode).toBe(404);
      expect(response.json().message).toContain('No mobile session');
    });

    it('rejects invalid request body', async () => {
      app = await buildTestApp(mobileUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          violationMinSeverity: 5, // Invalid: max is 3
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects invalid quiet hours format', async () => {
      app = await buildTestApp(mobileUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          quietHoursStart: '9:00', // Invalid format - should be HH:MM
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('rejects maxPerMinute outside valid range', async () => {
      app = await buildTestApp(mobileUser);

      const response = await app.inject({
        method: 'PATCH',
        url: '/notifications/preferences',
        payload: {
          maxPerMinute: 100, // Max is 60
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });
});
