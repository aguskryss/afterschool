-- =============================================================================
-- kikar-afterschool — Phase 47 ROLLBACK: Drop the per-block confirmations
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes this table has
--   been reverted. Also, and first:
--
--     • Remove 'block_checks' from TENANT_TABLES in server/tenancy.py, or the
--       next boot tries to add organization_id to a table that no longer
--       exists and fails before it reaches anything else.
--     • Remove ('/api/counselor/block-checks', 'daily_ops') from MODULE_ROUTES
--       in the same file.
--     • Remove the matching DDL and the two partial unique indexes from
--       init_db() in server/database.py, or the next boot puts the table
--       straight back.
--     • Revert web/src/routes/counselor/MyDay.tsx to the version that does not
--       call the endpoint, or every presence tap errors against an absent
--       table.
--
-- WHAT YOU LOSE
--   Every "this child was in front of me in this block" confirmation, for every
--   date. It is an operational audit trail: who was accounted for, in which
--   room, at which hour, and which counselor said so.
--
--   Attendance at the school gate is NOT here and is NOT lost —
--   `attendance_records` is a separate table and this migration never touched
--   it. Neither are absences: a parent's report lives in `absences`, and the
--   afternoon plan derives from it. So a rollback costs you the per-block
--   headcounts and nothing else about the day.
--
--   Export first if the JCC needs the trail for a compliance question:
--
--     COPY (SELECT b.organization_id, b.check_date, ch.name AS child,
--                  cs.name AS class_name, r.name AS room_name, b.time_block,
--                  u.email AS marked_by, b.created_at
--             FROM block_checks b
--             JOIN children ch ON ch.id = b.child_id
--             LEFT JOIN class_sessions cs ON cs.id = b.class_session_id
--             LEFT JOIN rooms r ON r.id = b.room_id
--             LEFT JOIN users u ON u.id = b.marked_by
--            ORDER BY b.organization_id, b.check_date, b.time_block)
--       TO '/tmp/block_checks_backup.csv' WITH CSV HEADER;
--
--   By name, not by id: ids do not survive a rebuild of the tables this one
--   points at, and the point of a backup is to be readable afterwards.
--
-- WHAT SURVIVES
--   children, rooms, class_sessions, users and attendance_records are
--   untouched — this migration only ever referenced them.
-- =============================================================================

BEGIN;

-- The partial uniques are created by init_db(), so drop them by name here too;
-- IF EXISTS covers a database where that boot never ran.
DROP INDEX IF EXISTS public.block_checks_class_unique;
DROP INDEX IF EXISTS public.block_checks_room_unique;

DROP INDEX IF EXISTS public.idx_block_checks_child;
DROP INDEX IF EXISTS public.idx_block_checks_date;

DROP TABLE IF EXISTS public.block_checks;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'block_checks';

COMMIT;
