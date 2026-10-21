-- =============================================================================
-- kikar-afterschool — Phase 73 ROLLBACK: Drop the special-day rosters
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes these tables
--   has been reverted:
--
--     • Remove 'special_days' and 'special_day_children' from TENANT_TABLES
--       (server/tenancy.py) and their CREATE TABLEs and the
--       special_days_one_per_date index from init_db() (server/database.py),
--       or the next boot puts them straight back.
--     • Revert registrations_for_date() and the /api/admin/special-days routes
--       in server/app.py. Every reader that went through it falls back to
--       `registrations`, which is what it read before.
--     • Revert the Special days screen and its nav entry in web/.
--
-- WHAT YOU LOSE
--   Every special-day list, past and upcoming. An upcoming early dismissal
--   goes back to the weekly enrollment, so check for future dates first:
--
--     SELECT sd.day_date, sd.note, count(sdc.id) AS children
--       FROM public.special_days sd
--       LEFT JOIN public.special_day_children sdc ON sdc.special_day_id = sd.id
--      WHERE sd.day_date >= CURRENT_DATE
--      GROUP BY sd.id ORDER BY sd.day_date;
--
-- WHAT SURVIVES
--   Everything else. Attendance already recorded on those dates is in
--   attendance_records and is not touched.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.special_day_children;
DROP TABLE IF EXISTS public.special_days;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('special_days', 'special_day_children');

COMMIT;
