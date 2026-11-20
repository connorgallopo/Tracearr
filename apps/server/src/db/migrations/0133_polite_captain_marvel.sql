CREATE TABLE "server_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"server_user_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"thumb_url" text,
	"is_primary" boolean,
	"is_child" boolean,
	"removed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "media_downloads" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "profile_id" uuid;--> statement-breakpoint
ALTER TABLE "server_profiles" ADD CONSTRAINT "server_profiles_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_profiles" ADD CONSTRAINT "server_profiles_server_user_id_server_users_id_fk" FOREIGN KEY ("server_user_id") REFERENCES "public"."server_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_profiles_server_external_unique" ON "server_profiles" USING btree ("server_id","external_id");--> statement-breakpoint
CREATE INDEX "server_profiles_server_user_idx" ON "server_profiles" USING btree ("server_user_id");--> statement-breakpoint
ALTER TABLE "media_downloads" ADD CONSTRAINT "media_downloads_profile_id_server_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."server_profiles"("id") ON DELETE no action ON UPDATE no action;