-- A person's picture is their most recently active account's that has one, as recomputeIdentityAggregates sets it
UPDATE "users" u SET "thumbnail" = (
  SELECT pa."thumb_url" FROM "server_users" pa
  WHERE pa."user_id" = u."id" AND pa."thumb_url" IS NOT NULL
  ORDER BY (pa."removed_at" IS NULL) DESC,
    (pa."plex_account_id" IS NOT NULL AND pa."plex_account_id" = u."plex_account_id") DESC,
    pa."last_activity_at" DESC NULLS LAST,
    pa."joined_at" ASC NULLS LAST,
    pa."id"
  LIMIT 1
)
WHERE EXISTS (SELECT 1 FROM "server_users" pa WHERE pa."user_id" = u."id" AND pa."thumb_url" IS NOT NULL);
