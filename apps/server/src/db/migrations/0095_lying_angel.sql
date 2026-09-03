CREATE TABLE "server_user_external_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_id" uuid NOT NULL,
	"external_id" varchar(255) NOT NULL,
	"server_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_user_external_aliases" ADD CONSTRAINT "server_user_external_aliases_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_user_external_aliases" ADD CONSTRAINT "server_user_external_aliases_server_user_id_server_users_id_fk" FOREIGN KEY ("server_user_id") REFERENCES "public"."server_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_user_external_aliases_server_external_unique" ON "server_user_external_aliases" USING btree ("server_id","external_id");--> statement-breakpoint
CREATE INDEX "server_user_external_aliases_server_user_idx" ON "server_user_external_aliases" USING btree ("server_user_id");