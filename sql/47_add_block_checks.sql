-- =============================================================================
-- kikar-afterschool — Phase 47: Confirming a child inside a class or care room
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds `block_checks`, the table behind the presence control on the
--   counselor's "My day" screen. One row means: on this date, in this block, a
--   counselor confirmed this child.
--
--   It is the §3.9 `AttendanceEvent` of the daily-ops spec, narrowed to the two
--   event kinds that screen actually produces — `class_checkin` and
--   `care_check`. The third, `bus_pickup`, already exists as
--   `attendance_records` and is NOT moved here; see the next banner.
--
-- WHY THIS IS NOT attendance_records
--   `attendance_records` answers "did this child arrive at the program today",
--   one row per child per DAY, written at a school gate. It is what Today's
--   arrival board reads and what a parent's absence cancels.
--
--   A counselor's afternoon asks a different question three or four times over:
--   "is this child in front of me, in THIS block, right now." A child is
--   legitimately confirmed in Swim L3 at 3:00 and again in Yoga at 4:00 — and
--   the chained child is confirmed twice for two different reasons, which is
--   the case R3 exists for. Folding that into the day-grained table would need
--   the day row to mean four things at once, and the second confirmation would
--   overwrite the first.
--
--   So: one row per child per BLOCK per date. The two tables answer two
--   questions and neither can silently answer the other's.
--
-- ABSENCE OF A ROW IS THE UNCONFIRMED STATE
--   There is no `status` column and un-confirming is a DELETE. A status column
--   here would carry 'here' and... nothing else the screen can produce, since
--   "absent" already has a home (`absences`, reported by the parent, surfaced
--   by _plan_for_day) and "not confirmed yet" is the absence of an answer
--   rather than an answer. A column whose only value is its own name is a
--   column that will eventually disagree with the table it duplicates.
--
-- WHY THE TARGET SHAPE MIRRORS staff_assignments
--   A block is a class, or a room for one time block — exactly the two things
--   phase 37 had to point at, with exactly the same problem (half the columns
--   nullable by design). The CHECKs are the same four, for the same reasons,
--   and the uniques are partial indexes for the same reason: tenancy rewrites
--   PER_ORG_UNIQUES as plain UNIQUE with no NULLS NOT DISTINCT, so a
--   five-column constraint over nullable columns would dedupe NOTHING while
--   looking like it did — and the ON CONFLICT that the write path rests on
--   would be a silent lie.
--
--   Those two indexes carry organization_id, which does not exist until the
--   tenancy pass adds it, so init_db() creates them rather than this file.
--   Applying this file alone is still safe: the next boot converges.
--
-- WHY marked_by IS ON DELETE SET NULL AND NOT CASCADE
--   The counselor who confirmed a child can leave the JCC. That is a staffing
--   change; it must not retroactively empty out an afternoon's headcounts. The
--   confirmation happened, and the row outlives the account that made it.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • 'block_checks' goes in TENANT_TABLES (server/tenancy.py), which is what
--     adds organization_id, its FK, its index and the org_isolation policy. Do
--     not add that column here.
--   • ('/api/counselor/block-checks', 'daily_ops') goes in MODULE_ROUTES in the
--     same file, or tests/test_module_access.py fails.
--   • The matching CREATE TABLE and the two partial uniques go in init_db()
--     (server/database.py), so a database that never ran this file converges.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.block_checks (
    id SERIAL PRIMARY KEY,
    child_id INTEGER NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
    check_date DATE NOT NULL,

    -- One target: a class, or a room for one block. Same pair as
    -- staff_assignments, so "the block I am standing in" has one spelling
    -- across the schema.
    class_session_id INTEGER REFERENCES public.class_sessions(id) ON DELETE CASCADE,
    room_id INTEGER REFERENCES public.rooms(id) ON DELETE CASCADE,
    time_block TEXT CHECK (time_block IS NULL OR time_block IN
        ('3-4', '4-5', '5-6')),

    -- Who tapped it, for the sign-out audit trail. Survives their account.
    marked_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- A row pointing at a class AND a room is two confirmations wearing one id,
    -- and every reader would have to guess which block it meant.
    CONSTRAINT block_checks_target_check CHECK (
        (class_session_id IS NOT NULL) <> (room_id IS NOT NULL)
    ),
    -- Care rooms are staffed and counted by the hour: "Noa is in Ocean" does
    -- not say when, so it cannot be confirmed.
    CONSTRAINT block_checks_room_block_check CHECK (
        room_id IS NULL OR time_block IS NOT NULL
    ),
    -- A class already carries its own hours. A second, independent time field
    -- on the same row is free to disagree with them.
    CONSTRAINT block_checks_class_block_check CHECK (
        class_session_id IS NULL OR time_block IS NULL
    )
);

-- -----------------------------------------------------------------------------
-- 2. Indexes for the two ways this is read: one counselor's whole afternoon
--    (every block on one date), and one child's history.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_block_checks_date
    ON public.block_checks (check_date);

CREATE INDEX IF NOT EXISTS idx_block_checks_child
    ON public.block_checks (child_id);

-- -----------------------------------------------------------------------------
-- 3. Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
--    per-organization policy and the organization_id column are installed by
--    init_db() via tenancy._ensure_policies(); this is the outer lock, not that
--    one. The table must be in TENANT_TABLES for the inner one.
-- -----------------------------------------------------------------------------
ALTER TABLE public.block_checks ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon ON public.block_checks;
CREATE POLICY deny_all_anon ON public.block_checks
    AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);
REVOKE ALL ON public.block_checks FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Sanity check — should return 1 row with rls_enabled = true.
-- -----------------------------------------------------------------------------
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'block_checks';

COMMIT;
