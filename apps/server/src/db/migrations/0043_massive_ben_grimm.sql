-- Enable pg_trgm extension for fuzzy text matching (used in duplicate detection)
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"library_id" varchar(100) NOT NULL,
	"rating_key" varchar(255) NOT NULL,
	"imdb_id" varchar(20),
	"tmdb_id" integer,
	"tvdb_id" integer,
	"title" varchar(500) NOT NULL,
	"media_type" varchar(20) NOT NULL,
	"year" integer,
	"video_resolution" varchar(20),
	"video_codec" varchar(50),
	"audio_codec" varchar(50),
	"audio_channels" integer,
	"file_size" bigint,
	"file_path" text,
	"grandparent_title" varchar(500),
	"grandparent_rating_key" varchar(255),
	"parent_title" varchar(500),
	"parent_rating_key" varchar(255),
	"parent_index" integer,
	"item_index" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "library_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"library_id" varchar(100) NOT NULL,
	"snapshot_time" timestamp with time zone NOT NULL,
	"item_count" integer NOT NULL,
	"total_size" bigint NOT NULL,
	"movie_count" integer DEFAULT 0 NOT NULL,
	"episode_count" integer DEFAULT 0 NOT NULL,
	"season_count" integer DEFAULT 0 NOT NULL,
	"show_count" integer DEFAULT 0 NOT NULL,
	"music_count" integer DEFAULT 0 NOT NULL,
	"count_4k" integer DEFAULT 0 NOT NULL,
	"count_1080p" integer DEFAULT 0 NOT NULL,
	"count_720p" integer DEFAULT 0 NOT NULL,
	"count_sd" integer DEFAULT 0 NOT NULL,
	"hevc_count" integer DEFAULT 0 NOT NULL,
	"h264_count" integer DEFAULT 0 NOT NULL,
	"av1_count" integer DEFAULT 0 NOT NULL,
	"enrichment_pending" integer DEFAULT 0 NOT NULL,
	"enrichment_complete" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_items" ADD CONSTRAINT "library_items_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "library_snapshots" ADD CONSTRAINT "library_snapshots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_library_items_imdb_partial" ON "library_items" USING btree ("imdb_id") WHERE "library_items"."imdb_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_library_items_tmdb_partial" ON "library_items" USING btree ("tmdb_id") WHERE "library_items"."tmdb_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_library_items_tvdb_partial" ON "library_items" USING btree ("tvdb_id") WHERE "library_items"."tvdb_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_library_items_server_library" ON "library_items" USING btree ("server_id","library_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "library_items_server_rating_key_unique" ON "library_items" USING btree ("server_id","rating_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_snapshots_server_library_time_idx" ON "library_snapshots" USING btree ("server_id","library_id","snapshot_time");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "library_snapshots_time_idx" ON "library_snapshots" USING btree ("snapshot_time");
--> statement-breakpoint

-- Hierarchy indexes for episode and track lookups
CREATE INDEX IF NOT EXISTS "idx_library_items_grandparent" ON "library_items" USING btree ("server_id","grandparent_rating_key") WHERE "grandparent_rating_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_library_items_parent" ON "library_items" USING btree ("server_id","parent_rating_key") WHERE "parent_rating_key" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_library_items_episode_lookup" ON "library_items" USING btree ("server_id","grandparent_rating_key","parent_index","item_index") WHERE "media_type" = 'episode';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_library_items_track_lookup" ON "library_items" USING btree ("server_id","grandparent_rating_key","parent_rating_key","item_index") WHERE "media_type" = 'track';
--> statement-breakpoint

-- Fix engagement functions to use array_agg instead of MAX for UUID fields
DROP FUNCTION IF EXISTS get_content_engagement(timestamptz, timestamptz, uuid, varchar);
--> statement-breakpoint
DROP FUNCTION IF EXISTS get_show_engagement(timestamptz, timestamptz, uuid);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_content_engagement(
  start_date timestamptz,
  end_date timestamptz,
  filter_server_id uuid DEFAULT NULL,
  filter_media_type text DEFAULT NULL
)
RETURNS TABLE (
  rating_key varchar(255),
  media_title text,
  show_title text,
  media_type text,
  content_duration_ms bigint,
  thumb_path text,
  server_id uuid,
  year integer,
  total_plays bigint,
  total_watched_ms numeric,
  total_watch_hours numeric,
  unique_viewers bigint,
  completions bigint,
  completion_rate numeric
) AS $$
  SELECT
    d.rating_key,
    MAX(d.media_title) AS media_title,
    MAX(d.show_title) AS show_title,
    MAX(d.media_type) AS media_type,
    MAX(d.content_duration_ms) AS content_duration_ms,
    MAX(d.thumb_path) AS thumb_path,
    (array_agg(d.server_id))[1] AS server_id,
    MAX(d.year) AS year,
    COUNT(*) AS total_plays,
    SUM(d.watched_ms) AS total_watched_ms,
    ROUND(SUM(d.watched_ms) / 3600000.0, 1) AS total_watch_hours,
    COUNT(DISTINCT d.server_user_id) AS unique_viewers,
    COUNT(*) FILTER (WHERE d.watched_ms >= d.content_duration_ms * 0.8) AS completions,
    ROUND(100.0 * COUNT(*) FILTER (WHERE d.watched_ms >= d.content_duration_ms * 0.8) / NULLIF(COUNT(*), 0), 1) AS completion_rate
  FROM daily_content_engagement d
  WHERE d.day >= start_date
    AND d.day < end_date
    AND (filter_server_id IS NULL OR d.server_id = filter_server_id)
    AND (filter_media_type IS NULL OR d.media_type = filter_media_type)
  GROUP BY d.rating_key
$$ LANGUAGE sql STABLE;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION get_show_engagement(
  start_date timestamptz,
  end_date timestamptz,
  filter_server_id uuid DEFAULT NULL
)
RETURNS TABLE (
  show_title text,
  server_id uuid,
  thumb_path text,
  year integer,
  total_episode_views bigint,
  total_watch_hours numeric,
  unique_viewers bigint,
  avg_completion_rate numeric,
  binge_score numeric
) AS $$
  SELECT
    d.show_title,
    (array_agg(d.server_id))[1] AS server_id,
    MAX(d.thumb_path) AS thumb_path,
    MAX(d.year) AS year,
    COUNT(*) AS total_episode_views,
    ROUND(SUM(d.watched_ms) / 3600000.0, 1) AS total_watch_hours,
    COUNT(DISTINCT d.server_user_id) AS unique_viewers,
    ROUND(100.0 * COUNT(*) FILTER (WHERE d.watched_ms >= d.content_duration_ms * 0.8) / NULLIF(COUNT(*), 0), 1) AS avg_completion_rate,
    LEAST(100, ROUND(
      40 * (COUNT(*)::numeric / NULLIF(COUNT(DISTINCT d.server_user_id), 0) / 10) +
      30 * (COUNT(DISTINCT d.day)::numeric / NULLIF(COUNT(DISTINCT d.server_user_id), 0) * 2) +
      30 * (COUNT(*) FILTER (WHERE d.watched_ms >= d.content_duration_ms * 0.8)::numeric / NULLIF(COUNT(*), 0))
    , 0))
  FROM daily_content_engagement d
  WHERE d.day >= start_date
    AND d.day < end_date
    AND d.show_title IS NOT NULL
    AND d.media_type = 'episode'
    AND (filter_server_id IS NULL OR d.server_id = filter_server_id)
  GROUP BY d.show_title
$$ LANGUAGE sql STABLE;
