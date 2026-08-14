-- =============================================================================
-- jclub-app — Phase 8: Recurring absences + per-day exceptions
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds two tables that let parents mark absences that repeat by weekday
--   (e.g. "every Tuesday and Thursday until June 30") and override a single
--   day inside that pattern (e.g. "this Tuesday my child does need transport"):
--
--     • recurring_absences   — one active rule per (child, day_of_week) with
--                              an optional end_date (NULL = indefinite).
--     • absence_exceptions   — per-day overrides that mean "child IS attending
--                              this date even if a recurring rule or one-off
--                              would otherwise mark them absent".
--
--   The Flask app's init_db() also creates these idempotently — this file is
--   for environments where DDL is reviewed and applied manually.
--
-- EFFECTIVE-ABSENCE RESOLUTION
--   A child is absent on date D iff:
--       (one-off in absences for (child, D)
--        OR active recurring_absences rule for (child, weekday(D))
--           with start_date <= D AND (end_date IS NULL OR end_date >= D))
--     AND NOT exists in absence_exceptions for (child, D)
--
-- WHY THIS IS SAFE
--   • Pure additive change: zero ALTER on any existing table.
--   • All FKs point at existing tables (children, users) and use ON DELETE
--     CASCADE / parent_id → users so deleting a child cascades both new tables.
--   • Re-running this file is safe (CREATE TABLE IF NOT EXISTS, CREATE INDEX
--     IF NOT EXISTS, CREATE POLICY guarded by drop-then-create).
--
-- DEPLOYMENT
--   1. Apply this file in Supabase SQL Editor (BEGIN/COMMIT wrapper makes it
--      all-or-nothing).
--   2. Deploy the Flask + frontend changes. init_db() will see the tables
--      already exist and no-op them.
--   3. Verify: log in as parent → "+ Add recurring absence" on a child card →
--      check that the next matching weekdays appear in Upcoming Absences.
--
-- ROLLBACK
--   See 09_rollback_recurring_absences.sql. Drops the two tables in dependency
--   order. Safe to run after reverting the application code.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Recurring rule: one row per (child, weekday) currently in effect.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.recurring_absences (
    id          SERIAL PRIMARY KEY,
    child_id    INTEGER NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
    day_of_week TEXT NOT NULL CHECK (day_of_week IN
                  ('Monday','Tuesday','Wednesday','Thursday','Friday')),
    start_date  TEXT NOT NULL,
    end_date    TEXT,
    marked_by   INTEGER NOT NULL REFERENCES public.users(id),
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (child_id, day_of_week)
);

CREATE INDEX IF NOT EXISTS idx_recurring_absences_child
    ON public.recurring_absences(child_id);
CREATE INDEX IF NOT EXISTS idx_recurring_absences_dow
    ON public.recurring_absences(day_of_week);

-- -----------------------------------------------------------------------------
-- 2. Per-day exception: child IS attending this specific date despite any
--    one-off or recurring absence that would otherwise apply.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.absence_exceptions (
    id              SERIAL PRIMARY KEY,
    child_id        INTEGER NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
    exception_date  TEXT NOT NULL,
    marked_by       INTEGER NOT NULL REFERENCES public.users(id),
    created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (child_id, exception_date)
);

CREATE INDEX IF NOT EXISTS idx_absence_exceptions_child
    ON public.absence_exceptions(child_id);
CREATE INDEX IF NOT EXISTS idx_absence_exceptions_date
    ON public.absence_exceptions(exception_date);

-- -----------------------------------------------------------------------------
-- 3. RLS lockdown — match the convention from 01_enable_rls_deny_all.sql.
--    The Flask backend uses the postgres role (BYPASSRLS), so its queries
--    keep working unchanged. PostgREST roles (anon, authenticated) are denied.
-- -----------------------------------------------------------------------------
ALTER TABLE public.recurring_absences  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.absence_exceptions  ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY['recurring_absences','absence_exceptions'];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('DROP POLICY IF EXISTS deny_all_anon ON public.%I', t);
        EXECUTE format(
            'CREATE POLICY deny_all_anon ON public.%I '
            'AS RESTRICTIVE FOR ALL TO anon, authenticated '
            'USING (false) WITH CHECK (false)',
            t
        );
        EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END LOOP;
END$$;

-- -----------------------------------------------------------------------------
-- 4. Sanity check — should return 2 rows, all with rowsecurity = true.
-- -----------------------------------------------------------------------------
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('recurring_absences','absence_exceptions')
ORDER BY tablename;

COMMIT;
