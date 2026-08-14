-- =============================================================================
-- kikar-afterschool — Phase 35: The class catalog (JCCSN, daily_ops)
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds the first two of the eight things §6.1 of the spec says the admin
--   configures, and from which the engine derives everything else:
--
--     • class_sessions    — the catalog. One row per class per weekday, with
--                           the end time the routing rule needs.
--     • class_enrollments — which child is in which class.
--
--   Together they unblock the `Dismiss To` engine (§4), and with it the
--   sign-out sheet, the care-room rosters and the bus manifest — every one of
--   which is downstream of "when does this child's last class end".
--
-- WHY NOT activity_schedules
--   The app already has activities and a schedule table, and they cannot do
--   this job:
--
--     • it ties a schedule to an activity by *name pattern*, not by id, so two
--       classes whose names merely resemble each other collide;
--     • it has dropoff_time and pickup_time but no end_time.
--
--   The second one is fatal. R2 compares the class end against the child's
--   dismissal time to decide "straight to a waiting parent" versus "wait in a
--   care room". With no end time there is no comparison and no routing, so a
--   new table is not a preference here.
--
-- WHY THE TIMES ARE NULLABLE
--   The roster spreadsheet names the classes but never gives their hours: the
--   M/T/W/R/F class columns hold "Chess", not "Chess 3:00–3:45". So the
--   importer can create the catalog but cannot fill it in, and a NOT NULL
--   end_time would force it to invent one.
--
--   Inventing it is the dangerous option, not the annoying one. A wrong end
--   time silently routes a child to a care room the parent is not standing in
--   — §6.3 asks for the *warning* ("child with no computable destination")
--   precisely so this stays visible instead of resolving itself wrongly. NULL
--   is what makes that warning possible.
--
-- WHY capacity IS NULLABLE AND UNUSED
--   §6.3 wants a "class over capacity" warning, but question 5 of §7 — are
--   there per-class and per-room caps at all — is still open with Heather. The
--   column is built optional so the catalog does not wait on the answer; until
--   it comes, nothing compares against it.
--
-- WHAT THIS DELIBERATELY LEAVES OUT
--   • A `season` column. §6.1 says "class catalog (per season)", but nothing
--     else in this schema knows what a season is — registrations do not carry
--     one either — so a column no code can scope against would be scaffolding.
--     When seasons become real they become real for both tables at once.
--   • Chaining (class A ends when class B starts → A dismisses to B). It is
--     derived from start/end times, so storing it would be a second source of
--     truth that can disagree with the first.
--   • A `source` column separating roster-created rows from hand-added ones.
--     Commit replaces a child's enrolments wholesale, exactly as it already
--     does for `registrations`, because the roster is the season's enrolment
--     record. If hand edits ever need to survive a re-import, that is the
--     change to make, and it needs its own decision.
--
-- WHAT THIS DOES NOT TOUCH
--   No existing table is altered and no existing row is rewritten. Other JCCs
--   never see either table: both are gated behind `daily_ops`, which is off by
--   default, and both are tenant-scoped like everything else.
--
-- ORDER
--   Apply after 29_add_daily_ops_foundation.sql — class_enrollments references
--   children, whose daily_ops columns that migration adds. Rollback is
--   36_rollback_class_sessions.sql, and it is destructive; read its banner.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. class_sessions — the catalog Heather fills in before anything derives.
--
--    Identity is (name, weekday): "Chess" on Monday and "Chess" on Wednesday
--    are two rows, because they can have different hours, rooms and rosters.
--    The unique is global here and init_db() rewrites it per organization via
--    PER_ORG_UNIQUES — two JCCs must both be allowed a class called "Chess".
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.class_sessions (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    day_of_week TEXT NOT NULL CHECK (day_of_week IN
                    ('Monday','Tuesday','Wednesday','Thursday','Friday')),
    start_time  TIME,
    end_time    TIME,
    location    TEXT,
    capacity    INTEGER,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (name, day_of_week),
    -- Half-filled is allowed — the importer creates rows with neither time —
    -- but backwards is not.
    CONSTRAINT class_sessions_time_order_check CHECK (
        start_time IS NULL OR end_time IS NULL OR end_time > start_time
    ),
    CONSTRAINT class_sessions_capacity_check CHECK (
        capacity IS NULL OR capacity > 0
    )
);

-- The derived views all ask the same question — "what runs on this weekday" —
-- once per screen per day.
CREATE INDEX IF NOT EXISTS idx_class_sessions_day
    ON public.class_sessions (day_of_week) WHERE active;

-- -----------------------------------------------------------------------------
-- 2. class_enrollments — which child is in which class.
--
--    A child may be in several classes on the same weekday: that is two rows
--    pointing at two class_sessions that both say 'Monday', and it is exactly
--    the case chaining exists for. The weekday is not repeated here — it lives
--    on the class, so the two cannot drift apart.
--
--    ON DELETE CASCADE both ways is deliberate. Deleting a class should not
--    leave enrolments pointing at nothing, and a withdrawn child should not
--    keep a seat; children.withdrawn_at is the audit trail, not this table.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.class_enrollments (
    id               SERIAL PRIMARY KEY,
    child_id         INTEGER NOT NULL
                         REFERENCES public.children(id) ON DELETE CASCADE,
    class_session_id INTEGER NOT NULL
                         REFERENCES public.class_sessions(id) ON DELETE CASCADE,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (child_id, class_session_id)
);

-- "Who is in this class" — the counselor's class block in §6.2, and the class
-- roster tab in §6.3. The (child_id, …) unique already serves the other
-- direction.
CREATE INDEX IF NOT EXISTS idx_class_enrollments_session
    ON public.class_enrollments (class_session_id);

-- -----------------------------------------------------------------------------
-- 3. Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
--    per-organization policies and the organization_id column are installed by
--    init_db() via tenancy._ensure_policies(); this is the outer lock, not
--    that one. Both tables must be in TENANT_TABLES for the inner one.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    t text;
    tables text[] := ARRAY['class_sessions', 'class_enrollments'];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
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
-- 4. Sanity check — should return 2 rows, both with rls_enabled = true.
-- -----------------------------------------------------------------------------
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('class_sessions', 'class_enrollments')
ORDER BY tablename;

COMMIT;
