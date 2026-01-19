CREATE TABLE "library_items" (
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
	"file_size" bigint,
	"file_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "library_snapshots" (
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
ALTER TABLE "library_items" ADD CONSTRAINT "library_items_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "library_snapshots" ADD CONSTRAINT "library_snapshots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_library_items_imdb_partial" ON "library_items" USING btree ("imdb_id") WHERE "library_items"."imdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_library_items_tmdb_partial" ON "library_items" USING btree ("tmdb_id") WHERE "library_items"."tmdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_library_items_tvdb_partial" ON "library_items" USING btree ("tvdb_id") WHERE "library_items"."tvdb_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_library_items_server_library" ON "library_items" USING btree ("server_id","library_id");--> statement-breakpoint
CREATE UNIQUE INDEX "library_items_server_rating_key_unique" ON "library_items" USING btree ("server_id","rating_key");--> statement-breakpoint
CREATE INDEX "library_snapshots_server_library_time_idx" ON "library_snapshots" USING btree ("server_id","library_id","snapshot_time");--> statement-breakpoint
CREATE INDEX "library_snapshots_time_idx" ON "library_snapshots" USING btree ("snapshot_time");