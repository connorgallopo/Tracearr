/**
 * Index set after migration 0118 and initTimescaleDB.
 *
 * Every sessions index is maintained on each insert and update and rebuilt on
 * each chunk compression, so the ones no query uses must stay gone on both
 * upgraded and fresh installs, and the ones queries rely on must survive.
 *
 * Run with: pnpm --filter @tracearr/server test:integration sessionIndexes
 */

import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../../src/db/client.js';

const DROPPED_SESSIONS_INDEXES = [
  'sessions_started_at_idx',
  'sessions_server_user_time_idx',
  'sessions_server_time_idx',
  'sessions_state_idx',
  'sessions_media_type_idx',
  'sessions_transcode_idx',
  'sessions_platform_idx',
  'idx_sessions_transcode_partial',
  'idx_sessions_source_resolution',
  'idx_sessions_source_video_codec',
  'idx_sessions_source_audio_codec',
  'idx_sessions_source_audio_channels',
  'idx_sessions_source_dynamic_range',
  'idx_sessions_source_video_details_gin',
  'idx_sessions_stream_audio_codec',
  'idx_sessions_stream_video_codec',
  'idx_sessions_transcode_info_gin',
  'idx_sessions_hw_encoding',
  'idx_sessions_music_artist',
  'idx_sessions_live_channel',
  'idx_sessions_live_tv_partial',
];

const KEPT_SESSIONS_INDEXES = [
  'sessions_pkey',
  'idx_sessions_open_last_seen',
  'sessions_active_lookup_idx',
  'idx_sessions_server_date_ref',
  'idx_sessions_device_tracking',
  'idx_sessions_media_type_ended',
  'idx_sessions_time_play_id',
];

async function indexNames(tables: string[]): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT indexname FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename IN (${sql.join(
        tables.map((t) => sql`${t}`),
        sql`, `
      )})
  `);
  return (result.rows as { indexname: string }[]).map((r) => r.indexname);
}

describe('session write path indexes', () => {
  it('drops the unused sessions indexes and keeps the ones queries use', async () => {
    const names = await indexNames(['sessions']);
    for (const name of DROPPED_SESSIONS_INDEXES) expect(names).not.toContain(name);
    for (const name of KEPT_SESSIONS_INDEXES) expect(names).toContain(name);
  });

  it('drops the duplicate and unused plain-table indexes', async () => {
    const names = await indexNames([
      'users',
      'server_users',
      'mobile_sessions',
      'notification_preferences',
    ]);
    for (const name of [
      'users_name_trgm_idx',
      'server_users_username_trgm_idx',
      'mobile_sessions_refresh_token_idx',
      'notification_prefs_mobile_session_idx',
    ]) {
      expect(names).not.toContain(name);
    }
    expect(names).toContain('mobile_sessions_refresh_token_hash_unique');
    expect(names).toContain('notification_preferences_mobile_session_id_unique');
  });

  it('does not recreate sessions_started_at_idx on a fresh hypertable', async () => {
    const names = await indexNames(['sessions']);
    expect(names).not.toContain('sessions_started_at_idx');
  });
});
