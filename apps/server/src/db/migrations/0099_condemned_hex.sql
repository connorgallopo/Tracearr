ALTER TABLE "newsletters" ADD COLUMN IF NOT EXISTS "sender_name" text;--> statement-breakpoint
ALTER TABLE "newsletters" ADD COLUMN IF NOT EXISTS "links" jsonb DEFAULT '{"tracearr":false}'::jsonb NOT NULL;--> statement-breakpoint
-- A text intro or outro becomes a one-paragraph document and blank text becomes null;
-- guarded on the column type so the file can be re-applied.
DO $$
BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'newsletters' AND column_name = 'intro'
        AND table_schema = current_schema()) = 'text' THEN
    ALTER TABLE "newsletters" ALTER COLUMN "intro" TYPE jsonb USING CASE
      WHEN "intro" IS NULL OR btrim("intro") = '' THEN NULL
      ELSE jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
        jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
          jsonb_build_object('type', 'text', 'text', btrim("intro"))))))
    END;
  END IF;
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_name = 'newsletters' AND column_name = 'outro'
        AND table_schema = current_schema()) = 'text' THEN
    ALTER TABLE "newsletters" ALTER COLUMN "outro" TYPE jsonb USING CASE
      WHEN "outro" IS NULL OR btrim("outro") = '' THEN NULL
      ELSE jsonb_build_object('type', 'doc', 'content', jsonb_build_array(
        jsonb_build_object('type', 'paragraph', 'content', jsonb_build_array(
          jsonb_build_object('type', 'text', 'text', btrim("outro"))))))
    END;
  END IF;
END $$;--> statement-breakpoint
UPDATE "newsletters" SET "recipients" = "recipients" || '{"excludeUserIds":[]}'::jsonb WHERE NOT ("recipients" ? 'excludeUserIds');
