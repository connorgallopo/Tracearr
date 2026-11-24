import type { NonMainProfile, ViolationWithDetails } from '@tracearr/shared';
import { createMockActiveSession } from '../../../test/fixtures.js';
import type { MediaEventPayload, NotificationEvent } from '../events.js';

export const violation: ViolationWithDetails = {
  id: 'violation-123',
  ruleId: 'rule-456',
  serverUserId: 'user-789',
  sessionId: 'session-123',
  severity: 'high',
  data: { reason: 'test violation' },
  acknowledgedAt: null,
  createdAt: new Date('2026-01-02T03:04:05.000Z'),
  user: {
    id: 'user-789',
    username: 'testuser',
    serverId: 'server-id',
    thumbUrl: null,
    identityName: 'Test User',
  },
  rule: { id: 'rule-456', name: 'Test Rule', type: 'concurrent_streams' },
};

export const session = createMockActiveSession({ durationMs: 3_725_000 });

export const KIDS: NonMainProfile = { name: 'Kids', thumbUrl: null, removed: false };

export const kidsSession = createMockActiveSession({
  mediaTitle: 'Bluey',
  durationMs: 3_725_000,
  user: { id: 'su-1', username: 'connor', thumbUrl: null, identityName: null },
  server: { id: 'server-1', name: 'Living Room', type: 'tofa' },
  nonMainProfile: KIDS,
});

const media: MediaEventPayload = {
  serverId: 'server-1',
  serverName: 'Basement',
  serverType: 'plex',
  libraryItemId: 'item-1',
  ratingKey: 'rk-1',
  mediaId: null,
  parentTitle: null,
  grandparentRatingKey: null,
  parentRatingKey: null,
  parentIndex: null,
  itemIndex: null,
  imdbId: null,
  tmdbId: null,
  tvdbId: null,
  thumbPath: null,
  title: 'Cars',
  grandparentTitle: null,
  mediaType: 'movie',
  year: 2006,
  libraryName: 'Movies',
  to: {
    resolution: '4k',
    dynamicRange: 'hdr10',
    videoCodec: 'HEVC',
    audioCodec: 'TRUEHD',
    audioChannels: 8,
    fileSize: 42_000_000_000,
  },
};

export const mediaUpgraded: NotificationEvent = {
  type: 'media_upgraded',
  payload: {
    ...media,
    from: {
      resolution: '1080p',
      dynamicRange: 'sdr',
      videoCodec: 'H264',
      audioCodec: 'AC3',
      audioChannels: 6,
      fileSize: 8_000_000_000,
    },
    changed: ['resolution'],
  },
};

export const mediaAdded: NotificationEvent = { type: 'media_added', payload: media };

export const severityEvents: NotificationEvent[] = [
  { type: 'violation', payload: violation },
  { type: 'session_started', payload: session },
  { type: 'server_down', payload: { serverName: 'Plex Server', serverId: 's1' } },
  { type: 'server_up', payload: { serverName: 'Plex Server', serverId: 's1' } },
];
