-- Migration: Add performance indexes for media type filtering
-- These indexes optimize queries that filter by media_type, which is now common
-- after adding live TV and music track support.

-- Composite index for time-based queries filtered by media type
-- Covers: dashboard stats, user activity, all queries with media_type IN ('movie', 'episode')
CREATE INDEX IF NOT EXISTS idx_sessions_media_type_ended
  ON sessions(media_type, stopped_at DESC);

-- Composite index for server + media type queries
-- Covers: per-server stats filtered by media type
CREATE INDEX IF NOT EXISTS idx_sessions_server_media_type
  ON sessions(server_id, media_type, stopped_at DESC);

-- Partial index for music tracks (only created when media_type = 'track')
-- Covers: music-specific queries without bloating index for other types
CREATE INDEX IF NOT EXISTS idx_sessions_music_artist
  ON sessions(artist_name, album_name)
  WHERE media_type = 'track';

-- Partial index for live TV (only created when media_type = 'live')
-- Covers: live TV channel queries without bloating index for other types
CREATE INDEX IF NOT EXISTS idx_sessions_live_channel
  ON sessions(channel_identifier, channel_title)
  WHERE media_type = 'live';

-- Composite index for server_user + media type queries
-- Covers: user stats filtered by media type
CREATE INDEX IF NOT EXISTS idx_sessions_user_media_type
  ON sessions(server_user_id, media_type, stopped_at DESC);
