-- =============================================================================
-- kikar-afterschool — Phase 19: Attendance check-in / check-out times
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds two nullable timestamp columns to attendance_records:
--
--     • checked_in_at   — stamped the first time a counselor marks the child
--                         present on a given day.
--     • checked_out_at  — stamped when the child is released to an authorized
--                         person (see 21_add_secure_pickup.sql).
--
--   Both are surfaced only to organizations with the `check_in_out` module
--   enabled. The columns are always written, so a JCC that buys the module
--   later already has its history.
--
-- WHY on_bus IS UNTOUCHED
--   `on_bus` remains the answer to "is this child here today". The roster
--   upload parser writes it, the counselor roster reads it, and every existing
--   attendance query filters on it. These columns are strictly additional; a
--   row with on_bus = 1 and checked_in_at = NULL is a pre-migration record,
--   not a broken one.
--
-- WHY THIS IS SAFE
--   • Purely additive: two nullable columns, no data rewritten, no constraint
--     added to existing rows.
--   • ADD COLUMN with no default does not rewrite the table in PostgreSQL 11+,
--     so this is a metadata-only change even on a large attendance history.
--   • Re-running is safe (IF NOT EXISTS).
--   • init_db() applies the same two statements on boot, so an environment
--     that deploys before this file is applied converges anyway.
--
-- ORDERING
--   Apply this BEFORE 21_add_secure_pickup.sql. The pickup release writes
--   checked_out_at, and would fail against a table that lacks the column.
--
-- DEPLOYMENT
--   1. Apply this file in the Supabase SQL Editor.
--   2. Deploy the application.
--   3. Verify: mark a child present as a counselor, then
--        SELECT child_id, on_bus, checked_in_at FROM attendance_records
--         WHERE attendance_date = CURRENT_DATE::text;
--      checked_in_at should carry a timestamp. Unmark and re-mark: the
--      timestamp moves, because unmarking clears the day.
--
-- ROLLBACK
--   See 20_rollback_attendance_times.sql. Dropping the columns loses the
--   recorded times permanently — the data lives nowhere else.
-- =============================================================================

BEGIN;

ALTER TABLE public.attendance_records
    ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP;

ALTER TABLE public.attendance_records
    ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMP;

-- Sanity check — should return both columns, is_nullable = YES.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'attendance_records'
  AND column_name IN ('checked_in_at', 'checked_out_at')
ORDER BY column_name;

COMMIT;
