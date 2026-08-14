-- =============================================================================
-- jclub-app — Phase 8 ROLLBACK: Drop recurring absences + exceptions
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads/writes recurring_absences
--   and absence_exceptions has been reverted. Otherwise the parent portal will
--   error trying to load these tables.
--
-- WHAT THIS DOES
--   Drops the two tables added in 08_add_recurring_absences.sql in dependency
--   order. Both are leaf tables (nothing references them), so order is purely
--   conventional.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.absence_exceptions;
DROP TABLE IF EXISTS public.recurring_absences;

-- Sanity check — should return 0 rows.
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('recurring_absences','absence_exceptions');

COMMIT;
