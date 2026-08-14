-- =============================================================================
-- ROLLBACK of sql/31_add_child_status.sql
-- =============================================================================
--
-- READ THIS FIRST
--   This drops the record of where each child was and who said so. on_bus and
--   checked_out_at survive, so "here" and "gone" are still answerable — but
--   `waiting`, `not_found` and `issue` have no equivalent in those two columns
--   and are simply lost. A child marked not_found becomes indistinguishable
--   from one never marked at all.
--
--   Copy it out first if any of it matters:
--
--     \copy (SELECT child_id, attendance_date, status, status_at, status_by,
--                   status_note
--              FROM public.attendance_records
--             WHERE status IS NOT NULL
--             ORDER BY attendance_date, child_id)
--       TO 'child_status.csv' CSV HEADER
--
--   Check what is about to be lost outright — these are the states with no
--   on_bus equivalent, and they are the ones a director would ask about:
--
--     SELECT attendance_date, status, count(*)
--       FROM public.attendance_records
--      WHERE status IN ('waiting', 'not_found', 'issue')
--      GROUP BY 1, 2 ORDER BY 1 DESC, 2;
--
-- ORDER
--   Roll the application back first. Code from phase 31 writes these columns
--   on every attendance tap and every release; without them each of those
--   requests errors, which takes out check-in during a live pickup.
--
-- WHAT DOES NOT NEED UNDOING
--   on_bus was kept in sync the whole time, so every "here" and "gone" is
--   already correct without status. That is why this rollback is a column
--   drop and not a data repair.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS public.idx_attendance_records_status;

ALTER TABLE public.attendance_records DROP CONSTRAINT IF EXISTS attendance_records_status_check;

ALTER TABLE public.attendance_records DROP COLUMN IF EXISTS status;
ALTER TABLE public.attendance_records DROP COLUMN IF EXISTS status_at;
ALTER TABLE public.attendance_records DROP COLUMN IF EXISTS status_by;
ALTER TABLE public.attendance_records DROP COLUMN IF EXISTS status_note;

COMMIT;
