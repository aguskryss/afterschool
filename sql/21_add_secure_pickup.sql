-- =============================================================================
-- kikar-afterschool — Phase 21: Secure pickup (authorized people + release log)
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds the two tables behind the `secure_pickup` module:
--
--     • authorized_pickup_people — the list a parent maintains of who may
--                                  collect their child (name, relationship).
--     • pickup_releases          — one row per child per day, written when a
--                                  counselor confirms who took them home.
--
-- WHAT THIS DOES NOT DO
--   It does not touch pickup_notifications or pickup_claim_audit. The
--   announce-then-claim queue is a separate module (`pickups`) and keeps
--   working exactly as it does today. A JCC can run the queue, this release
--   flow, both, or neither — North Shore runs this one and not the queue,
--   which is why nothing is being removed to make room for it.
--
-- WHY THE PERSON'S NAME IS DENORMALISED
--   pickup_releases stores person_name and person_relationship as text rather
--   than relying on the FK. This row is the record of who took a child home,
--   and it has to survive the parent later deleting that person from their
--   list. person_id is kept (ON DELETE SET NULL) for the cases where the
--   person still exists, but the text is the answer that has to hold.
--
-- WHY ONE RELEASE PER CHILD PER DAY
--   UNIQUE (child_id, release_date) makes a double-confirm a no-op rather than
--   a second row. Two counselors tapping at the same moment is a realistic
--   carpool-line event, not an edge case, and the second one must not create a
--   conflicting record of who left with the child.
--
-- TENANCY
--   Both tables are registered in TENANT_TABLES (server/tenancy.py), so
--   init_db() adds organization_id, its default, FK, index and RLS policies on
--   the next boot. Do not add those columns here — the tenancy layer owns them
--   and would fight this file over the details.
--
-- ORDERING
--   Apply 19_add_attendance_times.sql FIRST. The release stamps
--   attendance_records.checked_out_at, which that migration adds.
--
-- DEPLOYMENT
--   1. Apply 19, then this file, in the Supabase SQL Editor.
--   2. Deploy the application; init_db() sees the tables and adds tenancy.
--   3. Enable the `secure_pickup` module for the organization from the
--      superadmin console.
--   4. Verify: as a parent, add an authorized person; as a counselor, mark the
--      child present and release them to that person. Then
--        SELECT child_id, person_name, counselor_name, released_at
--          FROM pickup_releases ORDER BY released_at DESC LIMIT 5;
--
-- ROLLBACK
--   See 22_rollback_secure_pickup.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Who may collect this child. Maintained by the parent.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.authorized_pickup_people (
    id            SERIAL PRIMARY KEY,
    child_id      INTEGER NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
    name          TEXT NOT NULL,
    relationship  TEXT,
    created_by    INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (child_id, name)
);

CREATE INDEX IF NOT EXISTS idx_authorized_pickup_child
    ON public.authorized_pickup_people (child_id);

-- -----------------------------------------------------------------------------
-- 2. The release log. Append-only in practice: nothing in the application
--    updates or deletes these rows.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.pickup_releases (
    id                   SERIAL PRIMARY KEY,
    child_id             INTEGER NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
    person_id            INTEGER REFERENCES public.authorized_pickup_people(id) ON DELETE SET NULL,
    person_name          TEXT NOT NULL,
    person_relationship  TEXT,
    counselor_id         INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    counselor_name       TEXT NOT NULL,
    release_date         TEXT NOT NULL,
    released_at          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (child_id, release_date)
);

CREATE INDEX IF NOT EXISTS idx_pickup_releases_date
    ON public.pickup_releases (release_date);

-- -----------------------------------------------------------------------------
-- 3. Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
--    per-organization policies are installed by init_db() via
--    tenancy._ensure_policies(); this is the outer lock, not that one.
-- -----------------------------------------------------------------------------
ALTER TABLE public.authorized_pickup_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_releases          ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY['authorized_pickup_people','pickup_releases'];
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
-- 4. Sanity check — should return 2 rows, all with rls_enabled = true.
-- -----------------------------------------------------------------------------
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('authorized_pickup_people','pickup_releases')
ORDER BY tablename;

COMMIT;
