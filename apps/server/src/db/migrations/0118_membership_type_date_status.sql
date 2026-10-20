ALTER TABLE "users"
  RENAME COLUMN "membership_status" TO "membership_type";

UPDATE "users"
SET "membership_type" = CASE
  WHEN "membership_type" IN ('lifetime', 'whitelisted') THEN "membership_type"
  ELSE 'normal'
END;
