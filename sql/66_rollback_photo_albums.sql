-- =============================================================================
-- kikar-afterschool — Phase 65 ROLLBACK: Drop photo albums
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes this column has
--   been reverted:
--
--     • Remove the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS album_id` and its
--       backfill from init_db() in server/database.py, or the next boot puts
--       the column straight back.
--     • Revert server/app.py's photo upload/list endpoints to the version
--       that does not read or write `album_id`, and that only ever accepts
--       one file per upload.
--     • Revert web/src/routes/admin/Photos.tsx and
--       web/src/routes/counselor/Photos.tsx to the single-file, ungrouped
--       versions.
--
-- WHAT YOU LOSE
--   Which photos were uploaded together as one batch. Nothing else —
--   `photos`, `photo_tags` and every photo's own caption, date and storage
--   path are untouched; this migration only ever added one column.
--
-- WHAT SURVIVES
--   Every photo, every tag, every caption. A parent's gallery looks exactly
--   as it did before album_id existed — individual tiles, grouped by day,
--   same as always.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS public.idx_photos_album;

ALTER TABLE public.photos
    DROP COLUMN IF EXISTS album_id;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'photos'
  AND column_name = 'album_id';

COMMIT;
