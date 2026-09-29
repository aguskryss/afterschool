-- =============================================================================
-- kikar-afterschool — Phase 69 ROLLBACK: Drop the child profile photo column
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes this column has
--   been reverted:
--
--     • Remove the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS photo_path` from
--       init_db() in server/database.py, or the next boot puts it straight
--       back.
--     • Revert server/app.py's /photo routes and the `photo_url` fields, and
--       server/superadmin.py's UNION over children.photo_path.
--     • Revert the Avatar and the upload controls in web/.
--
-- WHAT YOU LOSE
--   Which child has which profile photo. The objects themselves stay in the
--   bucket under org-<id>/profile/ — list them BEFORE running this if they
--   should be deleted too, since afterwards nothing points at them:
--
--     SELECT organization_id, id, photo_path FROM public.children
--      WHERE photo_path IS NOT NULL;
--
-- WHAT SURVIVES
--   Every child, and every daily photo. Screens go back to initials avatars.
-- =============================================================================

BEGIN;

ALTER TABLE public.children
    DROP COLUMN IF EXISTS photo_path;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'children'
  AND column_name = 'photo_path';

COMMIT;
