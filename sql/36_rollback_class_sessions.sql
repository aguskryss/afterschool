-- =============================================================================
-- kikar-afterschool — Phase 35 ROLLBACK: Drop the class catalog
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes these tables has
--   been reverted. Also, and first:
--
--     • Remove 'class_sessions' and 'class_enrollments' from TENANT_TABLES in
--       server/tenancy.py, or the next boot tries to add organization_id to
--       tables that no longer exist and fails before it reaches anything else.
--     • Remove the two ('class_sessions', …) / ('class_enrollments', …)
--       entries from PER_ORG_UNIQUES in the same file, for the same reason.
--     • Remove the matching DDL from init_db() in server/database.py, or the
--       next boot puts both tables straight back.
--     • Revert _apply_registrations in server/roster_staging.py to the version
--       that only counts classes, or every commit errors on an absent table.
--
-- WHAT YOU LOSE
--   Every class in the catalog — its weekday, its hours, its location and its
--   capacity — and every child's enrolment in it.
--
--   The hours are the part worth pausing on. The roster spreadsheet does not
--   contain them: it names the classes and nothing more. Whatever start and
--   end times exist here were typed in by hand, once, by the admin, and
--   re-importing the roster will not bring them back. Export them first:
--
--     COPY (SELECT organization_id, name, day_of_week, start_time, end_time,
--                  location, capacity
--             FROM class_sessions ORDER BY organization_id, day_of_week, name)
--       TO '/tmp/class_sessions_backup.csv' WITH CSV HEADER;
--
--   The enrolments themselves are recoverable — they come from the roster, so
--   a re-import rebuilds them — but only for children the current roster still
--   lists.
--
-- WHAT SURVIVES
--   children, registrations (including dismissal_time), rooms and
--   care_assignment_rules are untouched. This migration never altered them, so
--   dropping it takes nothing else with it.
-- =============================================================================

BEGIN;

-- Enrolments first: they reference the catalog.
DROP INDEX IF EXISTS public.idx_class_enrollments_session;
DROP TABLE IF EXISTS public.class_enrollments;

DROP INDEX IF EXISTS public.idx_class_sessions_day;
DROP TABLE IF EXISTS public.class_sessions;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('class_sessions', 'class_enrollments');

COMMIT;
