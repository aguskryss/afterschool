-- =============================================================================
-- ROLLBACK of sql/33_add_counselor_assignment_dates.sql
-- =============================================================================
--
-- READ THIS FIRST
--   This drops counselor_school_changes, which is the only record of who
--   changed a counselor's schools and when. If any of it matters, copy it out
--   before running this:
--
--     \copy (SELECT * FROM public.counselor_school_changes ORDER BY id)
--       TO 'counselor_school_changes.csv' CSV HEADER
--
--   It also drops effective_from / effective_to. Any temporary assignment
--   becomes permanent the moment those columns go: a counselor covering a
--   school for one afternoon keeps that school indefinitely, and nobody is
--   told. Check for live windows first, and decide what each should become:
--
--     SELECT cs.counselor_id, u.name, cs.school_id, s.name AS school,
--            cs.effective_from, cs.effective_to
--       FROM public.counselor_schools cs
--       JOIN public.users u   ON u.id = cs.counselor_id
--       JOIN public.schools s ON s.id = cs.school_id
--      WHERE cs.effective_from IS NOT NULL OR cs.effective_to IS NOT NULL;
--
--   Deleting the expired ones before rolling back is usually what is meant:
--
--     DELETE FROM public.counselor_schools
--      WHERE effective_to IS NOT NULL AND effective_to < CURRENT_DATE;
--
-- ORDER
--   Roll the application back first. Code from phase 33 reads these columns to
--   decide who covers which school; without them every query errors, and the
--   fail-open path in counselor_school_ids() is not reached because the
--   statement never returns.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.counselor_school_changes;

DROP INDEX IF EXISTS public.idx_counselor_schools_school;

ALTER TABLE public.counselor_schools DROP CONSTRAINT IF EXISTS counselor_schools_window_check;

ALTER TABLE public.counselor_schools DROP COLUMN IF EXISTS effective_from;
ALTER TABLE public.counselor_schools DROP COLUMN IF EXISTS effective_to;
ALTER TABLE public.counselor_schools DROP COLUMN IF EXISTS assigned_by;
ALTER TABLE public.counselor_schools DROP COLUMN IF EXISTS assigned_at;

-- Remove 'counselor_school_changes' from TENANT_TABLES in server/tenancy.py in
-- the same deploy, or init_db() will try to add organization_id to a table
-- that no longer exists.

COMMIT;
