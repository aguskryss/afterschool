-- =============================================================================
-- kikar-afterschool — Phase 57: The bus as a third staff-assignment target
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds `school_id` to `staff_assignments` and to `block_checks`, so a
--   counselor's bus route (a school pickup) can be assigned the same way a
--   class or a care room already is: a weekly template (`day_of_week`) plus a
--   per-date override (`assignment_date`, `status='removed'` to stand someone
--   down for one day without touching the template) for the assignment, and a
--   tap-to-check confirmation per child for the manifest.
--
--   This is R8 and the §3.4 bus manifest, applied to the target the original
--   spec always listed alongside class/room
--   (docs/jccsn-daily-ops-spec.md:126: "block ∈ {bus, 3-4, 4-5, 5-6}") but
--   which sql/37 left out when it built the table.
--
-- WHY A THIRD COLUMN ON THE SAME TABLES, NOT A NEW PAIR OF TABLES
--   Exactly the reasoning in sql/37 for room_id vs class_session_id: one row is
--   one person (or one child, for block_checks) in one place at one time, and
--   the counselor-facing reads already select `WHERE counselor_id = me` (or
--   `WHERE check_date = ...`) across whatever targets exist. Splitting bus into
--   its own table would mean every such read unions two tables, and the R8
--   resolution (template minus 'removed' plus dated adds) would have to be
--   implemented twice.
--
-- WHY school_id NEVER CARRIES A time_block
--   A bus, like a class, is one thing for the whole afternoon — there is no
--   "3-4 bus" versus "4-5 bus". Same shape as `class_session_id`:
--   `staff_assignments_class_block_check` already reads
--   `class_session_id IS NULL OR time_block IS NULL`; school_id gets the
--   identical constraint rather than being folded into that one, so the two
--   targets can still be told apart by which check fired.
--
-- WHY THE TARGET CHECK BECOMES num_nonnulls(...) = 1
--   The old two-column XOR (`(class_session_id IS NOT NULL) <>
--   (room_id IS NOT NULL)`) has no three-column equivalent that reads as
--   plainly; `num_nonnulls()` is Postgres' own count-the-non-nulls builtin and
--   says "exactly one of these three" without three pairwise comparisons.
--
-- TENANCY
--   Both tables are already in TENANT_TABLES (server/tenancy.py) — this file
--   only adds a column and constraints, never organization_id.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • server/database.py's CREATE TABLE blocks for staff_assignments and
--     block_checks (and the partial-unique loops right after
--     ensure_tenancy_schema) must mirror this exactly, so a fresh database
--     converges to the same schema as a migrated one.
--   • No new MODULE_ROUTES entry: every endpoint touching these tables
--     (/api/admin/staff-assignments, /api/counselor/my-day,
--     /api/counselor/block-checks) is already registered under 'daily_ops'.
--   • /api/admin/schools/<id> DELETE must start counting staff_assignments
--     rows the same way /api/admin/class-sessions/<id> already does, or
--     deleting a school silently cascades away its bus staffing.
--
-- WHY THIS IS SAFE
--   Additive and idempotent. Every existing row has school_id NULL, which
--   changes nothing about which of class_session_id/room_id was set — the new
--   CHECK is satisfied by every row that satisfied the old one. init_db()
--   applies the same DDL on boot, so an environment that deploys before this
--   file runs converges anyway.
--
-- ORDERING
--   After sql/37 (staff_assignments) and sql/47 (block_checks).
--
-- ROLLBACK
--   sql/58_rollback_bus_assignments.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. staff_assignments — the bus as a target.
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assignments
    ADD COLUMN IF NOT EXISTS school_id INTEGER REFERENCES public.schools(id) ON DELETE CASCADE;

ALTER TABLE public.staff_assignments
    DROP CONSTRAINT IF EXISTS staff_assignments_target_check;
ALTER TABLE public.staff_assignments
    ADD CONSTRAINT staff_assignments_target_check CHECK (
        num_nonnulls(class_session_id, room_id, school_id) = 1
    );

ALTER TABLE public.staff_assignments DROP CONSTRAINT IF EXISTS staff_assignments_school_block_check;
ALTER TABLE public.staff_assignments
    ADD CONSTRAINT staff_assignments_school_block_check CHECK (
        school_id IS NULL OR time_block IS NULL
    );

-- -----------------------------------------------------------------------------
-- 2. block_checks — the bus as a confirmation target.
-- -----------------------------------------------------------------------------
ALTER TABLE public.block_checks
    ADD COLUMN IF NOT EXISTS school_id INTEGER REFERENCES public.schools(id) ON DELETE CASCADE;

ALTER TABLE public.block_checks
    DROP CONSTRAINT IF EXISTS block_checks_target_check;
ALTER TABLE public.block_checks
    ADD CONSTRAINT block_checks_target_check CHECK (
        num_nonnulls(class_session_id, room_id, school_id) = 1
    );

ALTER TABLE public.block_checks DROP CONSTRAINT IF EXISTS block_checks_school_block_check;
ALTER TABLE public.block_checks
    ADD CONSTRAINT block_checks_school_block_check CHECK (
        school_id IS NULL OR time_block IS NULL
    );

-- -----------------------------------------------------------------------------
-- 3. Sanity check — both columns should show up, nullable, referencing schools.
-- -----------------------------------------------------------------------------
SELECT table_name, column_name, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('staff_assignments', 'block_checks')
  AND column_name = 'school_id';

COMMIT;
