ALTER TABLE "media_requests" ALTER COLUMN "remote_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "media_requests" ALTER COLUMN "remote_media_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media_requests" ALTER COLUMN "remote_user_id" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "request_services" ALTER COLUMN "remote_server_id" DROP NOT NULL;