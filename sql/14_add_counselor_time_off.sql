-- =============================================================================
-- jclub-app — Phase 14: Counselor day-off requests + per-day roster overrides
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds two tables that power the counselor day-off workflow:
--
--     • counselor_time_off          — one request per (counselor, off_date).
--                                     Status starts 'pending'; admin approves,
--                                     rejects or counselor cancels while pending.
--     • activity_roster_overrides   — per-date reassignment of a roster entry.
--                                     Lets us reassign a recurring activity for
--                                     a single date without touching the base
--                                     recurrence in activity_roster.
--
--   The Flask app's init_db() also creates these idempotently — this file is
--   for environments where DDL is reviewed and applied manually.
--
-- EFFECTIVE-ASSIGNMENT RESOLUTION
--   For a roster entry R on date D, the effective counselor is:
--       COALESCE(
--         (SELECT assigned_counselor_id
--            FROM activity_roster_overrides
--           WHERE roster_entry_id = R.id AND override_date = D),
--         R.assigned_counselor_id
--       )
--   The override row may carry NULL to mean "this date is uncovered, surface
--   it in the admin reassignment panel".
--
-- WHY THIS IS SAFE
--   • Pure additive change: zero ALTER on any existing table.
--   • All FKs use ON DELETE CASCADE for time_off / overrides so deleting a
--     counselor or a roster entry cleans up dangling rows.
--   • Re-running this file is safe (CREATE TABLE/INDEX IF NOT EXISTS, policies
--     re-created via DROP-then-CREATE).
--   • Until the application starts writing to these tables they stay empty,
--     so the LEFT JOIN added to the roster queries is a no-op.
--
-- DEPLOYMENT
--   1. Apply this file in Supabase SQL Editor (BEGIN/COMMIT wrapper makes it
--      all-or-nothing).
--   2. Deploy the Flask + frontend changes. init_db() will see the tables
--      already exist and no-op them.
--   3. Verify: log in as counselor → "Request day off" → submit; admin sees
--      the request under "Day off requests" and can approve/reject.
--
-- ROLLBACK
--   See 15_rollback_counselor_time_off.sql. Drops the two tables in dependency
--   order (overrides first, time_off second). Safe to run after reverting the
--   application code.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Day-off request: one row per (counselor, off_date) that is pending or
--    approved. Rejected/cancelled rows are kept for history and do not block
--    re-submission of the same date.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.counselor_time_off (
    id            SERIAL PRIMARY KEY,
    counselor_id  INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    off_date      DATE NOT NULL,
    reason        TEXT,
    status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','cancelled')),
    reviewed_by   INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    reviewed_at   TIMESTAMP,
    review_note   TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Prevent double-booking the same counselor/day while a request is live.
-- Rejected/cancelled rows are excluded so the counselor can re-submit.
CREATE UNIQUE INDEX IF NOT EXISTS uq_counselor_time_off_active
    ON public.counselor_time_off (counselor_id, off_date)
    WHERE status IN ('pending','approved');

CREATE INDEX IF NOT EXISTS idx_counselor_time_off_status_date
    ON public.counselor_time_off (status, off_date);
CREATE INDEX IF NOT EXISTS idx_counselor_time_off_counselor
    ON public.counselor_time_off (counselor_id);

-- -----------------------------------------------------------------------------
-- 2. Per-date roster override: pinpoints "for THIS roster entry on THIS date,
--    the counselor is X" (or NULL = uncovered). One row per (entry, date).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.activity_roster_overrides (
    id                     SERIAL PRIMARY KEY,
    roster_entry_id        INTEGER NOT NULL
                           REFERENCES public.activity_roster(id) ON DELETE CASCADE,
    override_date          DATE NOT NULL,
    assigned_counselor_id  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    reason                 TEXT NOT NULL DEFAULT 'manual'
                           CHECK (reason IN ('time_off','manual')),
    source_time_off_id     INTEGER REFERENCES public.counselor_time_off(id)
                           ON DELETE SET NULL,
    created_by             INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (roster_entry_id, override_date)
);

CREATE INDEX IF NOT EXISTS idx_roster_overrides_date_counselor
    ON public.activity_roster_overrides (override_date, assigned_counselor_id);
CREATE INDEX IF NOT EXISTS idx_roster_overrides_source_time_off
    ON public.activity_roster_overrides (source_time_off_id);

-- -----------------------------------------------------------------------------
-- 3. RLS lockdown — match the convention from 01_enable_rls_deny_all.sql.
--    The Flask backend uses the postgres role (BYPASSRLS), so its queries
--    keep working unchanged. PostgREST roles (anon, authenticated) are denied.
-- -----------------------------------------------------------------------------
ALTER TABLE public.counselor_time_off          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_roster_overrides   ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY['counselor_time_off','activity_roster_overrides'];
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
  AND tablename IN ('counselor_time_off','activity_roster_overrides')
ORDER BY tablename;

COMMIT;
