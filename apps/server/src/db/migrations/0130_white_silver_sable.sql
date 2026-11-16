ALTER TABLE "server_users" ADD COLUMN "cloud_identity_id" text;--> statement-breakpoint
CREATE INDEX "server_users_cloud_identity_idx" ON "server_users" USING btree ("cloud_identity_id");