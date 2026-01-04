-- Migration: Add music track metadata support
-- This migration adds columns for music track information:
-- artist_name, album_name, track_number, disc_number
-- Note: media_type is stored as varchar, so 'track' value works without enum changes

-- Add music metadata columns to sessions table
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "artist_name" varchar(255);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "album_name" varchar(255);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "track_number" integer;
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "disc_number" integer;

-- Add comments explaining the columns
COMMENT ON COLUMN "sessions"."artist_name" IS 'Music track artist name';
COMMENT ON COLUMN "sessions"."album_name" IS 'Music track album name';
COMMENT ON COLUMN "sessions"."track_number" IS 'Track number in album';
COMMENT ON COLUMN "sessions"."disc_number" IS 'Disc number for multi-disc albums';
