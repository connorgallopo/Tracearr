ALTER TABLE "users"
  ADD COLUMN "membership_play_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "membership_last_annoy_date" date;

WITH consistent_overrides AS (
  SELECT
    "user_id",
    min("membership_status") AS membership_status,
    min("membership_expiration_date") AS membership_expiration_date,
    min("membership_enforcement_policy") AS membership_enforcement_policy
  FROM "server_users"
  WHERE "membership_override"
  GROUP BY "user_id"
  HAVING count(DISTINCT ROW(
    "membership_status",
    "membership_expiration_date",
    "membership_enforcement_policy"
  )) = 1
)
UPDATE "users" AS u
SET
  "membership_status" = overrides.membership_status,
  "membership_expiration_date" = overrides.membership_expiration_date,
  "membership_enforcement_policy" = overrides.membership_enforcement_policy
FROM consistent_overrides AS overrides
WHERE u."id" = overrides."user_id";

UPDATE "users" AS u
SET
  "membership_play_count" = account_state.play_count,
  "membership_last_annoy_date" = account_state.last_annoy_date
FROM (
  SELECT
    "user_id",
    max("membership_play_count") AS play_count,
    max("membership_last_annoy_date") AS last_annoy_date
  FROM "server_users"
  GROUP BY "user_id"
) AS account_state
WHERE u."id" = account_state."user_id";

ALTER TABLE "sessions"
  ADD COLUMN "membership_enforcement_decision" boolean;

ALTER TABLE "server_users"
  DROP COLUMN "membership_override",
  DROP COLUMN "membership_status",
  DROP COLUMN "membership_expiration_date",
  DROP COLUMN "membership_enforcement_policy",
  DROP COLUMN "membership_play_count",
  DROP COLUMN "membership_last_annoy_date";
