-- Migration: Add Live TV support
-- This migration adds support for Live TV streaming by:
-- 1. Adding new columns for channel information
-- 2. Note: media_type is stored as varchar, so 'live' value works without enum changes

-- Add Live TV specific columns to sessions table
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel_title" varchar(255);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel_identifier" varchar(100);
ALTER TABLE "sessions" ADD COLUMN IF NOT EXISTS "channel_thumb" varchar(500);

-- Add comment explaining the columns
COMMENT ON COLUMN "sessions"."channel_title" IS 'Live TV channel name (e.g., HBO, ESPN)';
COMMENT ON COLUMN "sessions"."channel_identifier" IS 'Live TV channel number or identifier';
COMMENT ON COLUMN "sessions"."channel_thumb" IS 'Live TV channel logo/thumbnail path';
