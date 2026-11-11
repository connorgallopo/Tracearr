CREATE TABLE "server_user_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"server_user_id" uuid NOT NULL,
	"provider" varchar(20) NOT NULL,
	"external_user_id" varchar(255) NOT NULL,
	"external_server_id" varchar(100) NOT NULL
);
--> statement-breakpoint
ALTER TABLE "server_user_links" ADD CONSTRAINT "server_user_links_server_user_id_server_users_id_fk" FOREIGN KEY ("server_user_id") REFERENCES "public"."server_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "server_user_links_unique" ON "server_user_links" USING btree ("server_user_id","provider","external_user_id","external_server_id");--> statement-breakpoint
CREATE INDEX "server_user_links_external_idx" ON "server_user_links" USING btree ("external_server_id","external_user_id");