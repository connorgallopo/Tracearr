-- Violations are the only runs read back joined to their session; stopped diagnostics age out in 30 days
UPDATE "automation_runs" ar SET "session_started_at" = s."started_at"
FROM "sessions" s
WHERE s."id" = ar."session_id"
  AND ar."kind" = 'policy' AND ar."outcome" = 'completed' AND ar."session_started_at" IS NULL;
