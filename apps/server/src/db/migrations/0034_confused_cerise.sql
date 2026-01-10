-- Migration: Add Plex GeoIP setting + sync missing columns from 0030-0033
-- Uses IF NOT EXISTS for idempotency (some columns may exist from manually-created migrations)

-- Live TV support columns (from 0030)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel_title" varchar(255);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel_identifier" varchar(100);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel_thumb" varchar(500);--> statement-breakpoint

-- Music metadata columns (from 0031)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "artist_name" varchar(255);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "album_name" varchar(255);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "track_number" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "disc_number" integer;--> statement-breakpoint

-- Stream details columns (from 0033)
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_video_codec" varchar(50);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_video_width" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_video_height" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_audio_codec" varchar(50);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_audio_channels" integer;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stream_video_codec" varchar(50);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stream_audio_codec" varchar(50);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_video_details" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "source_audio_details" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stream_video_details" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "stream_audio_details" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "transcode_info" jsonb;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "subtitle_info" jsonb;--> statement-breakpoint

-- Plex GeoIP setting (new)
ALTER TABLE "settings" ADD COLUMN IF NOT EXISTS "use_plex_geoip" boolean DEFAULT false NOT NULL;
