ALTER TABLE "media_requests" ADD COLUMN "poster_path" text;--> statement-breakpoint
ALTER TABLE "request_services" ADD COLUMN "takes_requests" boolean DEFAULT true NOT NULL;--> statement-breakpoint
CREATE INDEX "media_requests_service_poster_idx" ON "media_requests" USING btree ("service_id","poster_path") WHERE poster_path IS NOT NULL;