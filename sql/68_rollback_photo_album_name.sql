-- =============================================================================
-- kikar-afterschool — Phase 67 ROLLBACK: Drop the named-album column
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes this column has
--   been reverted:
--
--     • Remove the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS album_name` from
--       init_db() in server/database.py, or the next boot puts it straight
--       back.
--     • Revert server/app.py's photo upload/list endpoints to the version
--       that does not read or write `album_name`.
--     • Revert the admin, counselor and parent photo screens to the
--       versions with no album-naming checkbox and no named-album grouping.
--
-- WHAT YOU LOSE
--   Which batches were named albums, and what they were called. Nothing
--   else — every photo, every tag, every caption, and sql/65's album_id
--   grouping (still used for one-notification-per-batch) are untouched.
--
-- WHAT SURVIVES
--   Every photo and its album_id. Without album_name every batch simply
--   goes back to displaying as ordinary individual photos, which is exactly
--   how an unnamed batch already displays today.
-- =============================================================================

BEGIN;

ALTER TABLE public.photos
    DROP COLUMN IF EXISTS album_name;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'photos'
  AND column_name = 'album_name';

COMMIT;
