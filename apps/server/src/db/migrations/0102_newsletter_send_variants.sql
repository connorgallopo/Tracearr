-- The rendered digest moves off newsletter_sends into one row per variant, keyed by
-- the sorted server ids of the set a recipient belongs to. Every existing send gets one
-- union variant built from its newsletter's scope (every server when the scope names
-- none), every recipient row and the copied snapshot carry that key, and the five
-- rendered columns leave newsletter_sends. Server ids sort under the C collation so the
-- key matches variantKey() in @tracearr/shared byte for byte.
CREATE TABLE "newsletter_send_snapshots" (
	"send_id" uuid NOT NULL,
	"variant_key" text NOT NULL,
	"view_token" text NOT NULL,
	"subject" text NOT NULL,
	"html" text NOT NULL,
	"text" text NOT NULL,
	"posters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "newsletter_send_snapshots_send_id_variant_key_pk" PRIMARY KEY("send_id","variant_key"),
	CONSTRAINT "newsletter_send_snapshots_view_token_unique" UNIQUE("view_token")
);--> statement-breakpoint
ALTER TABLE "newsletter_send_snapshots" ADD CONSTRAINT "newsletter_send_snapshots_send_id_newsletter_sends_id_fk" FOREIGN KEY ("send_id") REFERENCES "public"."newsletter_sends"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "newsletter_sends" ADD COLUMN "variants" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletter_send_recipients" ADD COLUMN "variant_key" text;--> statement-breakpoint
UPDATE "newsletter_sends" AS s
SET "variants" = jsonb_build_array(jsonb_build_object(
  'key', v."key",
  'serverIds', v."ids",
  'serverNames', v."names",
  'recipientCount', s."recipient_count",
  'trimmed', '{"movies":0,"shows":0,"albums":0,"mostWatched":0}'::jsonb,
  'bytes', COALESCE(octet_length(s."html"), 0),
  'empty', s."outcome" = 'skipped_empty'))
FROM (
  SELECT s2."id" AS send_id,
         string_agg(sv."id"::text, ',' ORDER BY sv."id"::text COLLATE "C") AS "key",
         jsonb_agg(sv."id"::text ORDER BY sv."id"::text COLLATE "C") AS "ids",
         jsonb_agg(sv."name" ORDER BY sv."id"::text COLLATE "C") AS "names"
  FROM "newsletter_sends" s2
  JOIN "newsletters" n ON n."id" = s2."newsletter_id"
  JOIN "servers" sv ON jsonb_array_length(COALESCE(n."scope"->'serverIds', '[]'::jsonb)) = 0
                    OR n."scope"->'serverIds' ? sv."id"::text
  GROUP BY s2."id"
) AS v
WHERE v.send_id = s."id" AND jsonb_array_length(s."variants") = 0;--> statement-breakpoint
UPDATE "newsletter_send_recipients" AS r
SET "variant_key" = COALESCE(s."variants"->0->>'key', '')
FROM "newsletter_sends" s
WHERE s."id" = r."send_id" AND r."variant_key" IS NULL;--> statement-breakpoint
INSERT INTO "newsletter_send_snapshots" ("send_id", "variant_key", "view_token", "subject", "html", "text", "posters")
SELECT "id", COALESCE("variants"->0->>'key', ''), "view_token", "subject", "html", "text", "posters"
FROM "newsletter_sends"
WHERE "html" IS NOT NULL AND "text" IS NOT NULL
ON CONFLICT DO NOTHING;--> statement-breakpoint
ALTER TABLE "newsletter_send_recipients" ALTER COLUMN "variant_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletter_sends" DROP CONSTRAINT "newsletter_sends_view_token_unique";--> statement-breakpoint
ALTER TABLE "newsletter_sends" DROP COLUMN "view_token";--> statement-breakpoint
ALTER TABLE "newsletter_sends" DROP COLUMN "subject";--> statement-breakpoint
ALTER TABLE "newsletter_sends" DROP COLUMN "html";--> statement-breakpoint
ALTER TABLE "newsletter_sends" DROP COLUMN "text";--> statement-breakpoint
ALTER TABLE "newsletter_sends" DROP COLUMN "posters";
