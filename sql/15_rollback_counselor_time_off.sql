-- =============================================================================
-- jclub-app — Phase 14 ROLLBACK: Drop counselor time-off + roster overrides
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads/writes counselor_time_off
--   and activity_roster_overrides has been reverted. Otherwise the counselor
--   and admin portals will error trying to load these tables.
--
-- WHAT THIS DOES
--   Drops the two tables added in 14_add_counselor_time_off.sql in dependency
--   order (overrides references time_off via source_time_off_id, so overrides
--   must go first).
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.activity_roster_overrides;
DROP TABLE IF EXISTS public.counselor_time_off;

-- Sanity check — should return 0 rows.
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('counselor_time_off','activity_roster_overrides');

COMMIT;
