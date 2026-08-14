-- =============================================================================
-- kikar-afterschool — Phase 37 ROLLBACK: Drop the staff assignments
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes this table has
--   been reverted. Also, and first:
--
--     • Remove 'staff_assignments' from TENANT_TABLES in server/tenancy.py, or
--       the next boot tries to add organization_id to a table that no longer
--       exists and fails before it reaches anything else.
--     • Remove ('/api/admin/staff-assignments', 'daily_ops') from MODULE_ROUTES
--       in the same file.
--     • Remove the matching DDL and the two partial unique indexes from
--       init_db() in server/database.py, or the next boot puts the table
--       straight back.
--     • Revert the DELETE guards on /api/admin/rooms/<id> and
--       /api/admin/class-sessions/<id> to the versions that do not count these
--       rows, or every delete errors on an absent table.
--
-- WHAT YOU LOSE, AND WHY IT IS THE EXPENSIVE ONE
--   Every counselor's place in every class and every care room, for the weekly
--   template and for every dated override.
--
--   None of it is recoverable from anywhere else. The roster spreadsheet does
--   not contain it: the staff lists live in the HEADERS of the attendance
--   sheets, typed by hand, and the importer never reads them. Unlike class
--   hours — which at least sit inside the class names — this data has no second
--   copy in the system and no second copy in the source files.
--
--   Export it first. This is not a formality:
--
--     COPY (SELECT s.organization_id, u.email AS counselor, s.day_of_week,
--                  s.assignment_date, c.name AS class_name, r.name AS room_name,
--                  s.time_block, s.status
--             FROM staff_assignments s
--             JOIN users u ON u.id = s.counselor_id
--             LEFT JOIN class_sessions c ON c.id = s.class_session_id
--             LEFT JOIN rooms r ON r.id = s.room_id
--            ORDER BY s.organization_id, s.day_of_week, s.assignment_date,
--                     s.time_block)
--       TO '/tmp/staff_assignments_backup.csv' WITH CSV HEADER;
--
--   Exported by name, not by id, on purpose: ids do not survive a rebuild of
--   the tables this one points at, and the point of a backup is to be readable
--   after the thing it described is gone.
--
-- WHAT SURVIVES
--   users, rooms, class_sessions and care_assignment_rules are untouched — this
--   migration only ever referenced them. The care rules in particular are
--   independent by design: the staff pointed at (room_id, time_block), never at
--   a rule, so dropping the staffing leaves every grade range exactly as it was.
-- =============================================================================

BEGIN;

-- The partial uniques are created by init_db(), so drop them by name here too;
-- IF EXISTS covers a database where that boot never ran.
DROP INDEX IF EXISTS public.staff_assignments_class_unique;
DROP INDEX IF EXISTS public.staff_assignments_room_unique;

DROP INDEX IF EXISTS public.idx_staff_assignments_counselor;
DROP INDEX IF EXISTS public.idx_staff_assignments_date;
DROP INDEX IF EXISTS public.idx_staff_assignments_day;

DROP TABLE IF EXISTS public.staff_assignments;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'staff_assignments';

COMMIT;
