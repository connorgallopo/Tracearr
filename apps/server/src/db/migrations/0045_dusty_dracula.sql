CREATE TABLE "watch_sync_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_server_id" uuid NOT NULL,
	"target_server_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"dry_run" boolean DEFAULT true NOT NULL,
	"sync_movies" boolean DEFAULT true NOT NULL,
	"sync_shows" boolean DEFAULT true NOT NULL,
	"sync_in_progress" boolean DEFAULT true NOT NULL,
	"interval_minutes" integer DEFAULT 60 NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_sync_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_sync_configs_server_pair" UNIQUE("source_server_id","target_server_id")
);
--> statement-breakpoint
CREATE TABLE "watch_sync_user_mappings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"config_id" uuid NOT NULL,
	"source_server_user_id" uuid NOT NULL,
	"target_server_user_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	CONSTRAINT "watch_sync_user_mapping_unique" UNIQUE("config_id","source_server_user_id")
);
--> statement-breakpoint
ALTER TABLE "watch_sync_configs" ADD CONSTRAINT "watch_sync_configs_source_server_id_servers_id_fk" FOREIGN KEY ("source_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_sync_configs" ADD CONSTRAINT "watch_sync_configs_target_server_id_servers_id_fk" FOREIGN KEY ("target_server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_sync_user_mappings" ADD CONSTRAINT "watch_sync_user_mappings_config_id_watch_sync_configs_id_fk" FOREIGN KEY ("config_id") REFERENCES "public"."watch_sync_configs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_sync_user_mappings" ADD CONSTRAINT "watch_sync_user_mappings_source_server_user_id_server_users_id_fk" FOREIGN KEY ("source_server_user_id") REFERENCES "public"."server_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_sync_user_mappings" ADD CONSTRAINT "watch_sync_user_mappings_target_server_user_id_server_users_id_fk" FOREIGN KEY ("target_server_user_id") REFERENCES "public"."server_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_sync_configs_source_idx" ON "watch_sync_configs" USING btree ("source_server_id");--> statement-breakpoint
CREATE INDEX "watch_sync_configs_target_idx" ON "watch_sync_configs" USING btree ("target_server_id");--> statement-breakpoint
CREATE INDEX "watch_sync_user_mappings_config_idx" ON "watch_sync_user_mappings" USING btree ("config_id");--> statement-breakpoint
CREATE INDEX "watch_sync_user_mappings_source_user_idx" ON "watch_sync_user_mappings" USING btree ("source_server_user_id");--> statement-breakpoint
CREATE INDEX "watch_sync_user_mappings_target_user_idx" ON "watch_sync_user_mappings" USING btree ("target_server_user_id");