-- =============================================================================
-- kikar-afterschool — Phase 71 ROLLBACK: Drop the emergency headcount tables
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes these tables
--   has been reverted:
--
--     • Remove 'emergency_checks' and 'emergency_check_children' from
--       TENANT_TABLES (server/tenancy.py) and their CREATE TABLEs and the
--       emergency_checks_one_open index from init_db() (server/database.py),
--       or the next boot puts them straight back.
--     • Revert the /api/admin/emergency-check routes in server/app.py and
--       their MODULE_ROUTES entry.
--     • Revert the Emergency check screen and its nav entry in web/.
--
-- WHAT YOU LOSE
--   The record of every emergency check and drill: when it ran, who started
--   and closed it, and who accounted for which child. Export it first if the
--   JCC keeps drill records:
--
--     SELECT ec.*, ecc.child_id, ecc.accounted_at, ecc.accounted_by
--       FROM public.emergency_checks ec
--       LEFT JOIN public.emergency_check_children ecc ON ecc.check_id = ec.id
--      ORDER BY ec.started_at;
--
-- WHAT SURVIVES
--   Everything else. Attendance, check-in and check-out are not touched.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.emergency_check_children;
DROP TABLE IF EXISTS public.emergency_checks;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('emergency_checks', 'emergency_check_children');

COMMIT;
