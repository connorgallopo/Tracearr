CREATE TABLE "email_suppressions" (
	"address" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"source_send_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_suppressions_lower" CHECK ("email_suppressions"."address" = lower("email_suppressions"."address"))
);
--> statement-breakpoint
CREATE TABLE "newsletter_send_recipients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"send_id" uuid NOT NULL,
	"address" text NOT NULL,
	"user_id" uuid,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"error" text,
	"message_id" text,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "newsletter_sends" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"newsletter_id" uuid NOT NULL,
	"destination_id" uuid,
	"view_token" text NOT NULL,
	"trigger" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone NOT NULL,
	"item_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recipient_count" integer DEFAULT 0 NOT NULL,
	"outcome" text DEFAULT 'rendering' NOT NULL,
	"error" text,
	"subject" text DEFAULT '' NOT NULL,
	"html" text,
	"text" text,
	"posters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "newsletter_sends_view_token_unique" UNIQUE("view_token")
);
--> statement-breakpoint
CREATE TABLE "newsletters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"destination_id" uuid,
	"schedule" jsonb NOT NULL,
	"timezone" text NOT NULL,
	"window" jsonb NOT NULL,
	"scope" jsonb NOT NULL,
	"sections" jsonb NOT NULL,
	"subject" text NOT NULL,
	"intro" text,
	"outro" text,
	"recipients" jsonb NOT NULL,
	"image_mode" text DEFAULT 'auto' NOT NULL,
	"skip_when_empty" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "newsletters_name_unique" UNIQUE("name")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "contact_email" varchar(255);--> statement-breakpoint
ALTER TABLE "email_suppressions" ADD CONSTRAINT "email_suppressions_source_send_id_newsletter_sends_id_fk" FOREIGN KEY ("source_send_id") REFERENCES "public"."newsletter_sends"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_send_recipients" ADD CONSTRAINT "newsletter_send_recipients_send_id_newsletter_sends_id_fk" FOREIGN KEY ("send_id") REFERENCES "public"."newsletter_sends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_send_recipients" ADD CONSTRAINT "newsletter_send_recipients_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_sends" ADD CONSTRAINT "newsletter_sends_newsletter_id_newsletters_id_fk" FOREIGN KEY ("newsletter_id") REFERENCES "public"."newsletters"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletters" ADD CONSTRAINT "newsletters_destination_id_destinations_id_fk" FOREIGN KEY ("destination_id") REFERENCES "public"."destinations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_newsletter_send_recipients_send_status" ON "newsletter_send_recipients" USING btree ("send_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_sends_open_uidx" ON "newsletter_sends" USING btree ("newsletter_id") WHERE "newsletter_sends"."outcome" IN ('rendering', 'sending');--> statement-breakpoint
CREATE INDEX "idx_newsletter_sends_newsletter_started" ON "newsletter_sends" USING btree ("newsletter_id","started_at");--> statement-breakpoint
CREATE INDEX "idx_library_items_first_seen_active" ON "library_items" USING btree ("first_seen_at") WHERE "library_items"."removed_at" IS NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_contact_email_lower" CHECK ("users"."contact_email" IS NULL OR "users"."contact_email" = lower("users"."contact_email"));