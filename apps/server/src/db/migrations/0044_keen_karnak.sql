CREATE INDEX IF NOT EXISTS "idx_library_items_server_media_type" ON "library_items" USING btree ("server_id","media_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_library_items_server_created" ON "library_items" USING btree ("server_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_library_items_title_trgm" ON "library_items" USING gin ("title" gin_trgm_ops);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sessions_server_rating_idx" ON "sessions" USING btree ("server_id","rating_key");