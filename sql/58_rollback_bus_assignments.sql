-- =============================================================================
-- kikar-afterschool — Phase 57 ROLLBACK: Drop the bus target
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes school_id on
--   these two tables has been reverted. Also, and first:
--
--     • Revert /api/admin/schools/<id> DELETE to not count staff_assignments
--       rows, or a school with no children but a bus assignment cannot be
--       deleted afterwards.
--     • Remove the staff_assignments_school_unique and
--       block_checks_school_unique partial indexes from init_db() in
--       server/database.py, and the school_id column + its two CHECKs from
--       both CREATE TABLE blocks there, or the next boot puts them straight
--       back.
--
-- WHAT YOU LOSE
--   Every counselor's bus assignment — weekly template and dated overrides —
--   and every child's tap-to-check confirmation on a bus. Class and room
--   assignments/confirmations are untouched; only rows where school_id was set
--   disappear.
--
--   Export it first:
--
--     COPY (SELECT s.organization_id, u.email AS counselor, sc.name AS school,
--                  s.day_of_week, s.assignment_date, s.status
--             FROM staff_assignments s
--             JOIN users u ON u.id = s.counselor_id
--             JOIN schools sc ON sc.id = s.school_id
--            WHERE s.school_id IS NOT NULL
--            ORDER BY s.organization_id, sc.name, s.day_of_week, s.assignment_date)
--       TO '/tmp/bus_assignments_backup.csv' WITH CSV HEADER;
--
-- WHAT SURVIVES
--   Every row where school_id was already NULL — the class and room targets on
--   both tables — is untouched. schools itself is untouched; only the columns
--   pointing at it are dropped.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS public.staff_assignments_school_unique;
DROP INDEX IF EXISTS public.block_checks_school_unique;

ALTER TABLE public.staff_assignments DROP CONSTRAINT IF EXISTS staff_assignments_school_block_check;
ALTER TABLE public.staff_assignments DROP CONSTRAINT IF EXISTS staff_assignments_target_check;
ALTER TABLE public.staff_assignments
    ADD CONSTRAINT staff_assignments_target_check CHECK (
        (class_session_id IS NOT NULL) <> (room_id IS NOT NULL)
    );
ALTER TABLE public.staff_assignments DROP COLUMN IF EXISTS school_id;

ALTER TABLE public.block_checks DROP CONSTRAINT IF EXISTS block_checks_school_block_check;
ALTER TABLE public.block_checks DROP CONSTRAINT IF EXISTS block_checks_target_check;
ALTER TABLE public.block_checks
    ADD CONSTRAINT block_checks_target_check CHECK (
        (class_session_id IS NOT NULL) <> (room_id IS NOT NULL)
    );
ALTER TABLE public.block_checks DROP COLUMN IF EXISTS school_id;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT table_name, column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('staff_assignments', 'block_checks')
  AND column_name = 'school_id';

COMMIT;
