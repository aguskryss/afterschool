-- =============================================================================
-- kikar-afterschool — Phase 19 ROLLBACK: Drop attendance check-in/out times
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes checked_in_at /
--   checked_out_at has been reverted, and after 22_rollback_secure_pickup.sql
--   if that migration was applied — the pickup release writes checked_out_at.
--
-- WHAT YOU LOSE
--   Every recorded arrival and departure time. These columns are the only
--   place that data exists; there is no derived copy to rebuild them from.
--   Export first if the history matters:
--
--     SELECT child_id, attendance_date, checked_in_at, checked_out_at
--       FROM public.attendance_records
--      WHERE checked_in_at IS NOT NULL;
--
--   Attendance itself is unaffected: on_bus keeps answering "was this child
--   here", so rolling back costs the times and nothing else.
-- =============================================================================

BEGIN;

ALTER TABLE public.attendance_records DROP COLUMN IF EXISTS checked_out_at;
ALTER TABLE public.attendance_records DROP COLUMN IF EXISTS checked_in_at;

-- Sanity check — should return 0 rows.
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'attendance_records'
  AND column_name IN ('checked_in_at', 'checked_out_at');

COMMIT;
