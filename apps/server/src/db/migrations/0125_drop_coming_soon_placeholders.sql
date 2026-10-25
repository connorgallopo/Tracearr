DELETE FROM "library_items" c
USING "library_items" p
WHERE p."media_type" = 'episode'
  AND p."file_path" ~ '(^|[\\/])Season 00[\\/]S00E00\.Trailer\.mp4$'
  AND c."server_id" = p."server_id"
  AND c."media_type" IN ('show', 'season')
  AND c."rating_key" IN (p."grandparent_rating_key", p."parent_rating_key")
  AND NOT EXISTS (
    SELECT 1 FROM "library_items" e
    WHERE e."server_id" = c."server_id"
      AND e."media_type" = 'episode'
      AND e."grandparent_rating_key" =
        CASE WHEN c."media_type" = 'show' THEN c."rating_key" ELSE c."parent_rating_key" END
      AND (c."media_type" = 'show' OR e."parent_rating_key" = c."rating_key")
      AND (e."file_path" IS NULL OR e."file_path" !~ '(^|[\\/])Season 00[\\/]S00E00\.Trailer\.mp4$')
  );
--> statement-breakpoint
UPDATE "library_items" SET "replaces_library_item_id" = NULL
WHERE "replaces_library_item_id" IN (
  SELECT "id" FROM "library_items"
  WHERE "media_type" IN ('movie', 'episode')
    AND "file_path" ~ '\{edition-(Trailer|Placeholder|Coming Soon)\}\.mp4$|(^|[\\/])Season 00[\\/]S00E00\.Trailer\.mp4$'
);
--> statement-breakpoint
DELETE FROM "library_items"
WHERE "media_type" IN ('movie', 'episode')
  AND "file_path" ~ '\{edition-(Trailer|Placeholder|Coming Soon)\}\.mp4$|(^|[\\/])Season 00[\\/]S00E00\.Trailer\.mp4$';
