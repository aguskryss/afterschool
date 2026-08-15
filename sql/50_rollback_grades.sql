-- =============================================================================
-- kikar-afterschool — Phase 49 ROLLBACK: Drop the managed grades list
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes this table has
--   been reverted. Also, and first:
--
--     • Remove 'grades' from TENANT_TABLES in server/tenancy.py, or the next
--       boot tries to add organization_id to a table that no longer exists
--       and fails before it reaches anything else.
--     • Remove ('grades', 'grades_name_key', ('name',)) from PER_ORG_UNIQUES
--       in the same file.
--     • Remove the matching DDL from init_db() in server/database.py, or the
--       next boot puts the table straight back.
--     • Revert the admin routes/PATCH endpoints and the Grades screen in
--       web/src/routes/admin/Operations.tsx, and change the child forms'
--       grade picker back to free text.
--
-- WHAT YOU LOSE
--   The JCC's list of grade names and the order they display in. Nothing
--   about any individual child: grade_label and grade_num live on `children`
--   and are untouched — a child who already has a grade keeps it, there is
--   just no longer a menu of options offered when setting one by hand.
--
-- WHAT SURVIVES
--   children (including grade_label/grade_num), schools and everything else
--   — this migration only ever created its own table.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.grades;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'grades';

COMMIT;
