-- Migration: Add detailed stream metadata tracking
-- This migration adds comprehensive source and stream details for media playback,
-- using a hybrid approach: scalar columns for frequently-queried fields (indexed),
-- and JSONB columns for detailed/less-frequently-queried fields (flexible).
--
-- Matches Tautulli's stream details view showing:
-- - Source media: codec, resolution, bitrate, framerate, HDR, aspect ratio
-- - Stream output: codec, resolution, bitrate (after transcode)
-- - Audio: codec, channels, bitrate, language
-- - Transcode: container decisions, hardware acceleration, subtitle handling

-- ============================================================
-- SCALAR COLUMNS (High-frequency queries, indexed)
-- ============================================================

-- Source video (original file)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_video_codec" varchar(50);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_video_width" integer;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_video_height" integer;

-- Source audio
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_audio_codec" varchar(50);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_audio_channels" integer;

-- Stream video (what's delivered to client)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stream_video_codec" varchar(50);

-- Stream audio
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stream_audio_codec" varchar(50);

-- ============================================================
-- JSONB COLUMNS (Detailed fields, type-safe, flexible)
-- ============================================================

-- Source video details (bitrate, framerate, HDR, aspect ratio, profile, etc.)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_video_details" jsonb;

-- Source audio details (bitrate, channel layout, language, sample rate)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_audio_details" jsonb;

-- Stream video details (output bitrate, dimensions if scaled, framerate)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stream_video_details" jsonb;

-- Stream audio details (output bitrate, channels if downmixed, language)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stream_audio_details" jsonb;

-- Transcode info (container decisions, HW accel, speed, throttling)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "transcode_info" jsonb;

-- Subtitle info (decision, codec, language, forced)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "subtitle_info" jsonb;

-- ============================================================
-- COLUMN COMMENTS
-- ============================================================

-- Scalar columns
COMMENT ON COLUMN "sessions"."source_video_codec" IS 'Source video codec (H264, HEVC, VP9, AV1)';
COMMENT ON COLUMN "sessions"."source_video_width" IS 'Source video width in pixels';
COMMENT ON COLUMN "sessions"."source_video_height" IS 'Source video height in pixels';
COMMENT ON COLUMN "sessions"."source_audio_codec" IS 'Source audio codec (TrueHD, DTS-HD MA, AAC, FLAC)';
COMMENT ON COLUMN "sessions"."source_audio_channels" IS 'Source audio channel count (2, 6, 8)';
COMMENT ON COLUMN "sessions"."stream_video_codec" IS 'Stream video codec after transcode (or same as source if direct)';
COMMENT ON COLUMN "sessions"."stream_audio_codec" IS 'Stream audio codec after transcode (or same as source if direct)';

-- JSONB columns
COMMENT ON COLUMN "sessions"."source_video_details" IS 'Source video details: {bitrate, framerate, dynamicRange, aspectRatio, profile, level, colorSpace, colorDepth}';
COMMENT ON COLUMN "sessions"."source_audio_details" IS 'Source audio details: {bitrate, channelLayout, language, sampleRate}';
COMMENT ON COLUMN "sessions"."stream_video_details" IS 'Stream video details: {bitrate, width, height, framerate, dynamicRange}';
COMMENT ON COLUMN "sessions"."stream_audio_details" IS 'Stream audio details: {bitrate, channels, language}';
COMMENT ON COLUMN "sessions"."transcode_info" IS 'Transcode details: {containerDecision, sourceContainer, streamContainer, hwRequested, hwDecoding, hwEncoding, speed, throttled}';
COMMENT ON COLUMN "sessions"."subtitle_info" IS 'Subtitle details: {decision, codec, language, forced}';

-- ============================================================
-- B-TREE INDEXES (Fast equality/grouping on scalar columns)
-- ============================================================

-- Source codec indexes for GROUP BY aggregations
CREATE INDEX IF NOT EXISTS idx_sessions_source_video_codec
  ON sessions(source_video_codec)
  WHERE source_video_codec IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_source_audio_codec
  ON sessions(source_audio_codec)
  WHERE source_audio_codec IS NOT NULL;

-- Resolution index for 4K/1080p/720p filtering
CREATE INDEX IF NOT EXISTS idx_sessions_source_resolution
  ON sessions(source_video_width, source_video_height)
  WHERE source_video_width IS NOT NULL;

-- Audio channels index for surround sound filtering (5.1, 7.1, Atmos)
CREATE INDEX IF NOT EXISTS idx_sessions_source_audio_channels
  ON sessions(source_audio_channels)
  WHERE source_audio_channels IS NOT NULL;

-- Stream codec indexes
CREATE INDEX IF NOT EXISTS idx_sessions_stream_video_codec
  ON sessions(stream_video_codec)
  WHERE stream_video_codec IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sessions_stream_audio_codec
  ON sessions(stream_audio_codec)
  WHERE stream_audio_codec IS NOT NULL;

-- ============================================================
-- GIN INDEXES (JSONB containment queries using path_ops for efficiency)
-- ============================================================

-- Source video details (HDR filtering, bitrate ranges)
CREATE INDEX IF NOT EXISTS idx_sessions_source_video_details_gin
  ON sessions USING GIN (source_video_details jsonb_path_ops)
  WHERE source_video_details IS NOT NULL;

-- Transcode info (HW accel filtering, container decisions)
CREATE INDEX IF NOT EXISTS idx_sessions_transcode_info_gin
  ON sessions USING GIN (transcode_info jsonb_path_ops)
  WHERE transcode_info IS NOT NULL;

-- ============================================================
-- EXPRESSION INDEXES (Hot JSONB paths)
-- ============================================================

-- HDR/Dynamic range filtering (common dashboard filter)
CREATE INDEX IF NOT EXISTS idx_sessions_source_dynamic_range
  ON sessions ((source_video_details->>'dynamicRange'))
  WHERE source_video_details IS NOT NULL;

-- Hardware encoding filtering (transcode analysis)
CREATE INDEX IF NOT EXISTS idx_sessions_hw_encoding
  ON sessions ((transcode_info->>'hwEncoding'))
  WHERE transcode_info IS NOT NULL;
