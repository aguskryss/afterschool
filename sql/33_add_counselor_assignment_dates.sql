-- =============================================================================
-- kikar-afterschool — Phase 33: Dated, audited counselor school assignments
-- =============================================================================
--
-- WHAT THIS DOES
--   counselor_schools has been a bare (counselor_id, school_id) pair since the
--   beginning, and the only endpoint that writes it deletes every row for the
--   counselor and re-inserts the list it was handed. That is fine for "these
--   are Angelie's schools" and useless for the thing the program actually does
--   every week: someone calls out, and another counselor covers their school
--   for one afternoon without losing their own.
--
--     • effective_from / effective_to — the window an assignment applies to.
--       Both NULL is permanent, which is what every existing row is.
--     • assigned_by / assigned_at     — who put it there.
--     • counselor_school_changes      — the log. Who changed what, for whom,
--                                       when, and whether it was temporary.
--
-- WHY DATES ON THE EXISTING TABLE RATHER THAN A SECOND TABLE
--   The alternative was to leave counselor_schools alone as the permanent
--   assignment and add a `counselor_coverage` table for dated grants. It reads
--   cleaner and it is worse here: every query that asks "whose school is this
--   today" — the roster, the attendance write, the release, the child-coverage
--   check — would have to union two tables and get the precedence right in
--   four places. One table with a date window answers it once.
--
-- WHY BOTH DATES ARE NULLABLE, AND WHY THAT IS NOT A DEFAULT
--   Every row that exists today is a standing assignment with no end. NULL
--   means "no bound", so those rows keep meaning exactly what they meant and
--   no backfill is needed. A NOT NULL DEFAULT CURRENT_DATE would silently
--   assert that every assignment began the day this migration ran, which is
--   false and would then be quoted back as fact by the audit screen.
--
-- THE TRAP THIS MIGRATION SETS, AND HOW THE APPLICATION AVOIDS IT
--   counselor_school_ids() is deliberately fail-open: a counselor with NO rows
--   covers every school, because a JCC that has not divided its staff up needs
--   them working on day one. Introducing an end date creates a second, very
--   different state — a counselor who HAS rows, all of them expired. Reading
--   that as "no rows" would hand them every school in the organization at
--   midnight, silently, which is the opposite of what the admin asked for.
--
--   So the rule the application must keep, and has a test for: no rows at all
--   means all schools; rows that exist but none in effect means none. This
--   file cannot enforce that, which is exactly why it is written down here.
--
-- WHY THE LOG IS A TABLE AND NOT jsonb ON THE ASSIGNMENT
--   A removal has to survive the row it removed. Keeping history on
--   counselor_schools would lose every "took Glover away from Fischer" the
--   moment the assignment was deleted, and that is the half of the history
--   anyone would actually ask about.
--
-- TENANCY
--   counselor_school_changes is registered in TENANT_TABLES (server/tenancy.py),
--   so init_db() adds organization_id, its default, FK, index and the
--   org_isolation policy on the next boot. Do not add those columns here.
--
-- WHY THIS IS SAFE
--   Additive and idempotent. Every existing row is NULL in all four new
--   columns, so nothing is rewritten and the CHECK below validates without a
--   table scan worth deferring. init_db() applies the same DDL on boot, so an
--   environment that deploys before this file runs converges anyway.
--
-- ORDERING
--   No dependency on any earlier phase.
--
-- ROLLBACK
--   sql/34_rollback_counselor_assignment_dates.sql. It drops the log.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. counselor_schools — when the assignment applies, and who made it.
-- -----------------------------------------------------------------------------
ALTER TABLE public.counselor_schools ADD COLUMN IF NOT EXISTS effective_from DATE;
ALTER TABLE public.counselor_schools ADD COLUMN IF NOT EXISTS effective_to   DATE;
ALTER TABLE public.counselor_schools ADD COLUMN IF NOT EXISTS assigned_by    INTEGER
    REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.counselor_schools ADD COLUMN IF NOT EXISTS assigned_at    TIMESTAMP
    DEFAULT CURRENT_TIMESTAMP;

-- An assignment that ends before it starts covers nothing, and is far more
-- likely to be two fields typed in the wrong boxes than an intention.
DO $$ BEGIN
    ALTER TABLE public.counselor_schools ADD CONSTRAINT counselor_schools_window_check
        CHECK (effective_from IS NULL OR effective_to IS NULL
               OR effective_from <= effective_to);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- "Who is covering Brown today" is the hot path: the roster, every attendance
-- write and every release ask it.
CREATE INDEX IF NOT EXISTS idx_counselor_schools_school
    ON public.counselor_schools (school_id);

-- -----------------------------------------------------------------------------
-- 2. counselor_school_changes — the log.
--
--    school_id is NOT a foreign key on purpose. Deleting a school should not
--    quietly erase the record that someone was once assigned to it, and
--    ON DELETE SET NULL would leave a log line that cannot say which school it
--    was about. school_name is captured at write time for the same reason.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.counselor_school_changes (
    id             SERIAL PRIMARY KEY,
    counselor_id   INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    counselor_name TEXT NOT NULL,
    school_id      INTEGER,
    school_name    TEXT NOT NULL,
    action         TEXT NOT NULL,
    effective_from DATE,
    effective_to   DATE,
    changed_by     INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    changed_by_name TEXT NOT NULL,
    changed_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
    ALTER TABLE public.counselor_school_changes ADD CONSTRAINT counselor_school_changes_action_check
        CHECK (action IN ('added', 'removed', 'updated'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_counselor_school_changes_counselor
    ON public.counselor_school_changes (counselor_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_counselor_school_changes_at
    ON public.counselor_school_changes (changed_at DESC);

-- -----------------------------------------------------------------------------
-- 3. Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
--    per-organization policy is installed by init_db() via
--    tenancy._ensure_policies(); this is the outer lock, not that one.
-- -----------------------------------------------------------------------------
ALTER TABLE public.counselor_school_changes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon ON public.counselor_school_changes;
CREATE POLICY deny_all_anon ON public.counselor_school_changes
    AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);
REVOKE ALL ON public.counselor_school_changes FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Sanity check — 4 new columns on counselor_schools, and the log with RLS on.
-- -----------------------------------------------------------------------------
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'counselor_schools'
   AND column_name IN ('effective_from', 'effective_to', 'assigned_by', 'assigned_at')
 ORDER BY column_name;

SELECT tablename, rowsecurity AS rls_enabled
  FROM pg_tables
 WHERE schemaname = 'public' AND tablename = 'counselor_school_changes';

COMMIT;
