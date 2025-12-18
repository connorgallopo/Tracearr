/**
 * Notification service tests
 *
 * Tests the notification dispatch functionality:
 * - Discord webhook notifications
 * - Custom webhook notifications with different formats
 * - Ntfy authentication header handling
 * - Test webhook functionality
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NotificationService, sendTestWebhook } from '../notify.js';
import type { ViolationWithDetails, ActiveSession, Settings } from '@tracearr/shared';

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('NotificationService', () => {
  let notificationService: NotificationService;

  beforeEach(() => {
    notificationService = new NotificationService();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const createMockSettings = (overrides: Partial<Settings> = {}): Settings => ({
    allowGuestAccess: false,
    unitSystem: 'metric',
    discordWebhookUrl: null,
    customWebhookUrl: null,
    webhookFormat: null,
    ntfyTopic: null,
    ntfyAuthToken: null,
    pollerEnabled: true,
    pollerIntervalMs: 15000,
    tautulliUrl: null,
    tautulliApiKey: null,
    externalUrl: null,
    basePath: '',
    trustProxy: false,
    mobileEnabled: false,
    primaryAuthMethod: 'local',
    ...overrides,
  });

  const createMockViolation = (): ViolationWithDetails => ({
    id: 'violation-123',
    ruleId: 'rule-456',
    serverUserId: 'user-789',
    sessionId: 'session-123',
    severity: 'warning',
    data: { reason: 'test violation' },
    acknowledgedAt: null,
    createdAt: new Date(),
    user: {
      id: 'user-789',
      username: 'testuser',
      serverId: 'server-id',
      thumbUrl: null,
      identityName: 'Test User',
    },
    rule: {
      id: 'rule-456',
      name: 'Test Rule',
      type: 'concurrent_streams',
    },
  });

  const createMockSession = (): ActiveSession => ({
    id: 'session-123',
    serverId: 'server-456',
    serverUserId: 'user-789',
    sessionKey: 'key-123',
    state: 'playing',
    mediaTitle: 'Test Movie',
    mediaType: 'movie',
    grandparentTitle: null,
    seasonNumber: null,
    episodeNumber: null,
    year: 2024,
    thumbPath: null,
    ratingKey: 'rating-123',
    externalSessionId: null,
    startedAt: new Date(),
    stoppedAt: null,
    durationMs: 3600000,
    totalDurationMs: 7200000,
    progressMs: 3600000,
    lastPausedAt: null,
    pausedDurationMs: 0,
    referenceId: null,
    watched: false,
    ipAddress: '192.168.1.1',
    geoCity: 'New York',
    geoRegion: 'NY',
    geoCountry: 'US',
    geoLat: 40.7128,
    geoLon: -74.006,
    playerName: 'Test Device',
    deviceId: 'device-123',
    product: 'Test Client',
    device: 'Desktop',
    platform: 'Windows',
    quality: '1080p',
    isTranscode: false,
    bitrate: 10000,
    videoDecision: 'directplay',
    audioDecision: 'directplay',
    user: {
      id: 'user-789',
      username: 'testuser',
      thumbUrl: null,
      identityName: 'Test User',
    },
    server: {
      id: 'server-456',
      name: 'Test Server',
      type: 'plex',
    },
  });

  describe('notifyViolation', () => {
    it('sends discord webhook for violations', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const settings = createMockSettings({
        discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
      });

      await notificationService.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://discord.com/api/webhooks/123/abc',
        expect.objectContaining({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        })
      );
    });

    it('sends custom webhook with ntfy format and auth token', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'tracearr-alerts',
        ntfyAuthToken: 'tk_secret_token_123',
      });

      await notificationService.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tk_secret_token_123',
          },
        })
      );

      // Verify ntfy payload structure
      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.topic).toBe('tracearr-alerts');
      expect(body.title).toBe('Violation Detected');
      expect(body.priority).toBeGreaterThanOrEqual(1);
      expect(body.priority).toBeLessThanOrEqual(5);
    });

    it('sends custom webhook with ntfy format without auth token', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'tracearr-alerts',
        ntfyAuthToken: null,
      });

      await notificationService.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
        })
      );

      // Should NOT have Authorization header
      const callArgs = mockFetch.mock.calls[0]!;
      expect(callArgs[1].headers).not.toHaveProperty('Authorization');
    });

    it('sends custom webhook with apprise format (no auth)', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const settings = createMockSettings({
        customWebhookUrl: 'https://apprise.example.com/notify',
        webhookFormat: 'apprise',
      });

      await notificationService.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify apprise payload structure
      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.title).toBe('Violation Detected');
      expect(body.body).toContain('testuser');
      expect(body.type).toBe('warning');
    });

    it('sends custom webhook with json format', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const settings = createMockSettings({
        customWebhookUrl: 'https://example.com/webhook',
        webhookFormat: 'json',
      });

      await notificationService.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Verify json payload structure
      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.event).toBe('violation_detected');
      expect(body.timestamp).toBeDefined();
      expect(body.data).toBeDefined();
    });

    it('sends to both discord and custom webhooks', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const settings = createMockSettings({
        discordWebhookUrl: 'https://discord.com/api/webhooks/123/abc',
        customWebhookUrl: 'https://example.com/webhook',
        webhookFormat: 'json',
      });

      await notificationService.notifyViolation(createMockViolation(), settings);

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('notifyServerDown', () => {
    it('sends ntfy notification with auth token for server down', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'server-alerts',
        ntfyAuthToken: 'tk_server_token',
      });

      await notificationService.notifyServerDown('Plex Server', settings);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tk_server_token',
          },
        })
      );

      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.topic).toBe('server-alerts');
      expect(body.title).toBe('Server Down');
      expect(body.message).toContain('Plex Server');
      expect(body.priority).toBe(5); // High priority for server down
    });
  });

  describe('notifyServerUp', () => {
    it('sends ntfy notification with auth token for server up', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'server-alerts',
        ntfyAuthToken: 'tk_server_token',
      });

      await notificationService.notifyServerUp('Plex Server', settings);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tk_server_token',
          },
        })
      );

      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.title).toBe('Server Online');
      expect(body.message).toContain('Plex Server');
    });
  });

  describe('notifySessionStarted', () => {
    it('sends ntfy notification with auth for session start', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const settings = createMockSettings({
        customWebhookUrl: 'https://ntfy.example.com',
        webhookFormat: 'ntfy',
        ntfyTopic: 'sessions',
        ntfyAuthToken: 'tk_session_token',
      });

      await notificationService.notifySessionStarted(createMockSession(), settings);

      expect(mockFetch).toHaveBeenCalledWith(
        'https://ntfy.example.com',
        expect.objectContaining({
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer tk_session_token',
          },
        })
      );

      const callArgs = mockFetch.mock.calls[0]!;
      const body = JSON.parse(callArgs[1].body);
      expect(body.title).toBe('Stream Started');
      expect(body.message).toContain('Test User'); // Uses identityName when available
      expect(body.message).toContain('Test Movie');
    });
  });
});

describe('sendTestWebhook', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('sends discord test webhook', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await sendTestWebhook('https://discord.com/api/webhooks/123/abc', 'discord');

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://discord.com/api/webhooks/123/abc',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1].body);
    expect(body.username).toBe('Tracearr');
    expect(body.embeds[0].title).toBe('Test Notification');
  });

  it('sends ntfy test webhook with auth token', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await sendTestWebhook(
      'https://ntfy.example.com',
      'custom',
      'ntfy',
      'tracearr-test',
      'tk_test_token_123'
    );

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ntfy.example.com',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tk_test_token_123',
        },
      })
    );

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1].body);
    expect(body.topic).toBe('tracearr-test');
    expect(body.title).toBe('Test Notification');
    expect(body.tags).toContain('tracearr');
  });

  it('sends ntfy test webhook without auth token', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await sendTestWebhook(
      'https://ntfy.example.com',
      'custom',
      'ntfy',
      'tracearr-test',
      null
    );

    expect(result.success).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://ntfy.example.com',
      expect.objectContaining({
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
      })
    );

    // Should NOT have Authorization header
    const callArgs = mockFetch.mock.calls[0]!;
    expect(callArgs[1].headers).not.toHaveProperty('Authorization');
  });

  it('sends apprise test webhook', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await sendTestWebhook('https://apprise.example.com/notify', 'custom', 'apprise');

    expect(result.success).toBe(true);

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1].body);
    expect(body.title).toBe('Test Notification');
    expect(body.type).toBe('success');
  });

  it('sends json test webhook', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await sendTestWebhook('https://example.com/webhook', 'custom', 'json');

    expect(result.success).toBe(true);

    const callArgs = mockFetch.mock.calls[0]!;
    const body = JSON.parse(callArgs[1].body);
    expect(body.event).toBe('test');
    expect(body.data.source).toBe('tracearr');
    expect(body.data.test).toBe(true);
  });

  it('returns error when webhook fails', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await sendTestWebhook(
      'https://ntfy.example.com',
      'custom',
      'ntfy',
      'test',
      'bad_token'
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).toContain('Unauthorized');
  });

  it('returns error when fetch throws', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await sendTestWebhook('https://unreachable.example.com', 'custom', 'json');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Network error');
  });
});
