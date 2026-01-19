-- Enable pg_trgm extension for fuzzy text matching (cross-server duplicate detection)
CREATE EXTENSION IF NOT EXISTS pg_trgm;

--> statement-breakpoint
-- Create GIN index for trigram similarity on library_items.title
-- Used for fuzzy title matching when items lack external IDs (IMDB/TMDB/TVDB)
CREATE INDEX IF NOT EXISTS idx_library_items_title_trgm
ON library_items USING GIN (title gin_trgm_ops);
