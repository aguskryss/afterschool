-- =============================================================================
-- kikar-afterschool — Phase 49: A managed list of grades, instead of free text
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds `grades`, a per-organization reference list ("K", "1", "2", …) that
--   the child create/edit forms pick from instead of typing a grade by hand.
--   Same shape and purpose as `schools`: a JCC sets its own list once, and
--   every other screen reads from it rather than trusting free text.
--
-- WHY THIS EXISTS ALONGSIDE children.grade_label AND grade_num
--   Nothing here changes how a child's own grade is stored — that is still
--   grade_label (the roster's own spelling) and grade_num (what care rules
--   compare against), both on `children`, both still filled in by
--   parse_grade() in server/roster_import.py for both the spreadsheet
--   importer and manual entry. This table is only the menu a human picks
--   from; it does not replace the two columns that record the pick.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • 'grades' goes in TENANT_TABLES (server/tenancy.py), which is what adds
--     organization_id, its FK, its index and the org_isolation policy. Do
--     not add that column here.
--   • ('grades', 'grades_name_key', ('name',)) goes in PER_ORG_UNIQUES in
--     the same file, so two JCCs can both have a grade called "K".
--   • The matching CREATE TABLE goes in init_db() (server/database.py), so a
--     database that never ran this file converges on the next boot.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.grades (
    id SERIAL PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    -- Display order. Auto-filled from parse_grade() when the name is a
    -- recognized grade (K, 1st, 2, …) so the common case sorts itself;
    -- otherwise appended to the end. Not derived at query time because an
    -- admin renaming a custom label should not reshuffle the list.
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- 2. Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
--    per-organization policy and the organization_id column are installed by
--    init_db() via tenancy._ensure_policies(); this is the outer lock, not
--    that one. The table must be in TENANT_TABLES for the inner one.
-- -----------------------------------------------------------------------------
ALTER TABLE public.grades ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon ON public.grades;
CREATE POLICY deny_all_anon ON public.grades
    AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);
REVOKE ALL ON public.grades FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- 3. Sanity check — should return 1 row with rls_enabled = true.
-- -----------------------------------------------------------------------------
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'grades';

COMMIT;
