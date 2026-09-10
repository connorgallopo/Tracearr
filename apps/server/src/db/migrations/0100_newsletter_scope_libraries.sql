-- scope.libraryIds held bare library ids, which collide across servers (Plex
-- section ids start at 1 everywhere). Each id becomes a (serverId, libraryId)
-- pair for every server in the scope (every server on the install when
-- serverIds is empty) that has that library, which is exactly what the bare id
-- used to match; an id no server has is dropped. Rows already carrying
-- "libraries" are left alone, so the file can be re-applied.
UPDATE "newsletters" AS n
SET "scope" = (n."scope" - 'libraryIds') || jsonb_build_object('libraries', COALESCE((
  SELECT jsonb_agg(
           jsonb_build_object('serverId', l."server_id", 'libraryId', l."library_id")
           ORDER BY l."server_id", l."library_id")
  FROM jsonb_array_elements_text(n."scope"->'libraryIds') AS ids("id")
  JOIN "libraries" l ON l."library_id" = ids."id"
  WHERE jsonb_array_length(COALESCE(n."scope"->'serverIds', '[]'::jsonb)) = 0
     OR n."scope"->'serverIds' ? l."server_id"::text
), '[]'::jsonb))
WHERE n."scope" ? 'libraryIds' AND NOT (n."scope" ? 'libraries');--> statement-breakpoint
UPDATE "newsletters" SET "scope" = "scope" || '{"libraries":[]}'::jsonb WHERE NOT ("scope" ? 'libraries');
