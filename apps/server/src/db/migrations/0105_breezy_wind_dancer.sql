ALTER TABLE "library_snapshots" ADD COLUMN "count_8k" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "library_snapshots" ADD COLUMN "count_1440p" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "library_snapshots" ADD COLUMN "count_480p" integer DEFAULT 0 NOT NULL;