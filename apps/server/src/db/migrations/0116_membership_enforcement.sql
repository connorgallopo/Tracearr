ALTER TABLE "users"
  ADD COLUMN "membership_status" varchar(20) NOT NULL DEFAULT 'unpaid',
  ADD COLUMN "membership_expiration_date" date,
  ADD COLUMN "membership_enforcement_policy" varchar(32);

ALTER TABLE "server_users"
  ADD COLUMN "membership_override" boolean NOT NULL DEFAULT false,
  ADD COLUMN "membership_status" varchar(20) NOT NULL DEFAULT 'unpaid',
  ADD COLUMN "membership_expiration_date" date,
  ADD COLUMN "membership_enforcement_policy" varchar(32),
  ADD COLUMN "membership_play_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN "membership_last_annoy_date" date;
