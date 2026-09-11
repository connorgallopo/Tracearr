CREATE TABLE "media_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_id" uuid NOT NULL,
	"remote_id" integer NOT NULL,
	"remote_media_id" integer NOT NULL,
	"media_type" varchar(10) NOT NULL,
	"title" text,
	"year" integer,
	"tmdb_id" integer,
	"tvdb_id" integer,
	"imdb_id" varchar(20),
	"rating_key" varchar(255),
	"media_id" uuid,
	"server_user_id" uuid,
	"remote_user_id" integer NOT NULL,
	"remote_username" text NOT NULL,
	"remote_plex_id" varchar(64),
	"remote_jellyfin_user_id" varchar(64),
	"status" varchar(20) NOT NULL,
	"seasons" jsonb,
	"is_4k" boolean DEFAULT false NOT NULL,
	"is_auto_request" boolean DEFAULT false NOT NULL,
	"requested_at" timestamp with time zone NOT NULL,
	"available_at" timestamp with time zone,
	"remote_updated_at" timestamp with time zone NOT NULL,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_services" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"type" varchar(20) NOT NULL,
	"name" text NOT NULL,
	"url" text NOT NULL,
	"config" text,
	"config_status" varchar(20) DEFAULT 'ok' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"remote_server_id" text NOT NULL,
	"version" text,
	"sync_cursor" timestamp with time zone,
	"last_counts" jsonb,
	"last_sync_at" timestamp with time zone,
	"last_full_sync_at" timestamp with time zone,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_requests" ADD CONSTRAINT "media_requests_service_id_request_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."request_services"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media_requests" ADD CONSTRAINT "media_requests_server_user_id_server_users_id_fk" FOREIGN KEY ("server_user_id") REFERENCES "public"."server_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_services" ADD CONSTRAINT "request_services_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "media_requests_service_remote_unique" ON "media_requests" USING btree ("service_id","remote_id");--> statement-breakpoint
CREATE INDEX "media_requests_media_idx" ON "media_requests" USING btree ("media_id");--> statement-breakpoint
CREATE INDEX "media_requests_server_user_idx" ON "media_requests" USING btree ("server_user_id");--> statement-breakpoint
CREATE INDEX "media_requests_requested_at_idx" ON "media_requests" USING btree ("requested_at");--> statement-breakpoint
CREATE INDEX "media_requests_service_updated_idx" ON "media_requests" USING btree ("service_id","remote_updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "request_services_server_unique" ON "request_services" USING btree ("server_id");