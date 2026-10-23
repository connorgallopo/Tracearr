DELETE FROM "media_downloads" d
USING "library_items" li
WHERE d."source" = 'plex'
  AND li."server_id" = d."server_id"
  AND li."rating_key" = d."rating_key"
  AND li."media_type" = 'track';
