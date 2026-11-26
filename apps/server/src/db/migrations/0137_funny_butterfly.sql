CREATE TABLE "session_link_repairs" (
	"session_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"repair_version" integer NOT NULL,
	"server_id" uuid NOT NULL,
	"clause" text NOT NULL,
	"grandparent_title" text,
	"media_id" uuid,
	"show_media_id" uuid,
	"imdb_id" varchar(20),
	"tmdb_id" integer,
	"tvdb_id" integer,
	"parent_rating_key" text,
	"grandparent_rating_key" text,
	"relinked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_link_repairs_session_id_started_at_repair_version_pk" PRIMARY KEY("session_id","started_at","repair_version")
);
--> statement-breakpoint
CREATE INDEX "session_link_repairs_version_relinked_idx" ON "session_link_repairs" USING btree ("repair_version","relinked_at");