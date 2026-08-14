-- =============================================================================
-- kikar-afterschool — Phase 37: Who is in each class and each care room
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds `staff_assignments`, the table that holds what the two attendance
--   sheets write in the header of every block and no table could store until
--   now: the list of counselors.
--
--     Ocean Room (K): Katelyn, LaRae & Lila
--     Bball 3:15p-4p Courts: Fischer, Mattea, Mollie
--
--   This is the thing the director actually asked for. Everything shipped in
--   phases 29 and 35 — rooms, the class catalog, the care rules — exists so
--   that these rows have something to point at.
--
-- ONE ROW IS ONE PERSON IN ONE PLACE AT ONE TIME
--   Not a slot with a list. A counselor in two blocks of the same day is two
--   rows (Mollie is in `Bball 3:15p-4p` and in `Gym (2-4)` 4-5), which is what
--   lets the counselor-facing view select `WHERE counselor_id = me` and get a
--   day rather than filter a JSON array in the application.
--
-- WHY THE TARGET IS (room_id, time_block) AND NOT care_assignment_rules.id
--   A care rule is "grades 1-4 wait in the Gym from 4 to 5". It is tempting to
--   hang the staff off the rule, since the rule is what creates the group.
--
--   It is also wrong, and R7 says why: the grade split "varies with headcount",
--   and §6.3 asks for the headcount precisely so the director can move it. She
--   changes "Gym (1-4)" to "Gym (2-4)" as a matter of routine. If the staff hung
--   off the rule, editing that range would delete Katelyn from the Gym — a
--   staffing change nobody asked for, caused by a rostering change.
--
--   Pointing at the room and the block instead keeps the two independent: the
--   grade range decides which children arrive, the assignment decides who is
--   standing there to receive them.
--
-- WHY A WEEKLY TEMPLATE AND A PER-DATE OVERRIDE IN ONE TABLE
--   R8, in her words: "theoretically every Monday should be the same… unless
--   someone calls out and I have to move people around."
--
--     day_of_week     — the weekly template. Every Monday, forever.
--     assignment_date — one date only. The call-out.
--
--   Exactly one of the two is set, enforced by a CHECK. Both would be
--   redundant — a date already knows its weekday — and redundant columns are
--   how a row comes to contradict itself. Phase 29 refused to add
--   children.status next to children.active for the same reason.
--
--   `status` is what makes a subtractive override possible: a 'removed' row for
--   one date takes Katelyn out of Ocean 3-4 that day WITHOUT touching LaRae and
--   Lila, who are in the same block by the same template. An override model
--   where any per-date row replaced the whole block would wipe them, which is
--   the opposite of "move one person around". 'removed' only makes sense for a
--   date, so a CHECK confines it there.
--
-- WHY THE UNIQUES ARE NOT IN PER_ORG_UNIQUES
--   They cannot be. tenancy.ensure_tenancy_schema rewrites every entry in that
--   tuple as a plain `UNIQUE (organization_id, <cols>)`, with no
--   `NULLS NOT DISTINCT`. Under Postgres' default semantics two rows that
--   differ only where one holds NULL do not collide — and half the columns
--   here are nullable by design, so a six-column constraint would dedupe
--   NOTHING while looking like it did, and any ON CONFLICT resting on it would
--   be a silent lie.
--
--   So the uniques are two PARTIAL indexes, one per kind of target, and the
--   nullable template/date pair is made total with COALESCE sentinels. Note it
--   cannot be folded into one string instead: casting a DATE to text is not
--   IMMUTABLE — it reads DateStyle — so Postgres refuses it in an index
--   expression, and to_char is only STABLE. A bare date literal is a constant.
--   The CHECK below guarantees exactly one of the pair is set, so a sentinel can
--   never be confused with a real value.
--
--   They are created by init_db() rather than here, because they include
--   organization_id and that column does not exist until the tenancy pass adds
--   it. Applying this file alone is still safe: the next boot converges.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • 'staff_assignments' goes in TENANT_TABLES (server/tenancy.py), which is
--     what adds organization_id, its FK, its index and the org_isolation
--     policy. Do not add that column here.
--   • ('/api/admin/staff-assignments', 'daily_ops') goes in MODULE_ROUTES, or
--     tests/test_module_access.py fails.
--   • The DELETE guards on rooms and class_sessions must start counting these
--     rows. Both FKs below are ON DELETE CASCADE, so without that, deleting a
--     room would silently take its staffing with it.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.staff_assignments (
    id SERIAL PRIMARY KEY,
    counselor_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,

    -- Exactly one of these two. See the banner.
    day_of_week TEXT CHECK (day_of_week IS NULL OR day_of_week IN
        ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday')),
    assignment_date DATE,

    -- Exactly one of these two, as well: a class, or a room for one block.
    class_session_id INTEGER REFERENCES public.class_sessions(id) ON DELETE CASCADE,
    room_id INTEGER REFERENCES public.rooms(id) ON DELETE CASCADE,
    time_block TEXT CHECK (time_block IS NULL OR time_block IN
        ('3-4', '4-5', '5-6')),

    status TEXT NOT NULL DEFAULT 'assigned'
        CHECK (status IN ('assigned', 'removed')),

    created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

    -- A template row or a single-date row, never both and never neither.
    CONSTRAINT staff_assignments_when_check CHECK (
        (day_of_week IS NOT NULL) <> (assignment_date IS NOT NULL)
    ),
    -- One target. A row pointing at a class AND a room is two assignments
    -- wearing one id, and every reader would have to guess which it meant.
    CONSTRAINT staff_assignments_target_check CHECK (
        (class_session_id IS NOT NULL) <> (room_id IS NOT NULL)
    ),
    -- A room without a block is not a shift: care rooms are staffed by the
    -- hour, and "Katelyn is in Ocean" does not say when.
    CONSTRAINT staff_assignments_room_block_check CHECK (
        room_id IS NULL OR time_block IS NOT NULL
    ),
    -- A class already carries its own hours. A second, independent time field
    -- on the same row is free to disagree with them.
    CONSTRAINT staff_assignments_class_block_check CHECK (
        class_session_id IS NULL OR time_block IS NULL
    ),
    -- 'removed' answers "not today". Against the template it would mean
    -- "never", which is what deleting the row already means.
    CONSTRAINT staff_assignments_removed_check CHECK (
        status = 'assigned' OR assignment_date IS NOT NULL
    )
);

-- -----------------------------------------------------------------------------
-- 2. Indexes for the three ways this is read: a weekday's template, a date's
--    overrides, and one counselor's own day (§6.2, R9).
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_staff_assignments_day
    ON public.staff_assignments (day_of_week) WHERE day_of_week IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_assignments_date
    ON public.staff_assignments (assignment_date) WHERE assignment_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_staff_assignments_counselor
    ON public.staff_assignments (counselor_id);

-- -----------------------------------------------------------------------------
-- 3. Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
--    per-organization policy and the organization_id column are installed by
--    init_db() via tenancy._ensure_policies(); this is the outer lock, not
--    that one. The table must be in TENANT_TABLES for the inner one.
-- -----------------------------------------------------------------------------
ALTER TABLE public.staff_assignments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_all_anon ON public.staff_assignments;
CREATE POLICY deny_all_anon ON public.staff_assignments
    AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);
REVOKE ALL ON public.staff_assignments FROM anon, authenticated;

-- -----------------------------------------------------------------------------
-- 4. Sanity check — should return 1 row with rls_enabled = true.
-- -----------------------------------------------------------------------------
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'staff_assignments';

COMMIT;
