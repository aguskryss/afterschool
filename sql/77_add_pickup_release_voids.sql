-- =============================================================================
-- kikar-afterschool — Phase 77: Voiding a mistaken pickup release
-- =============================================================================
--
-- WHAT THIS DOES
--   Lets an admin void a release recorded by mistake (the wrong child tapped
--   in the carpool line). The release is never edited or deleted: the row is
--   moved whole — signature included — into pickup_release_voids, next to who
--   voided it, when, and why. The child's attendance goes back to "present",
--   and the correct release can then be recorded as usual.
--
--   A separate table rather than a voided_at column on pickup_releases, so
--   pickup_releases keeps its UNIQUE (child_id, release_date): every existing
--   reader keeps meaning "the release that stands", and a container still
--   running the previous code during a rolling deploy keeps inserting with
--   ON CONFLICT (child_id, release_date) as before.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • 'pickup_release_voids' goes in TENANT_TABLES (server/tenancy.py), which
--     adds organization_id, its FK, its index and the org_isolation policy. Do
--     NOT add those columns here.
--   • init_db() mirrors the CREATE TABLE, so a deploy that boots before this
--     file is applied converges anyway.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.pickup_release_voids (
    id SERIAL PRIMARY KEY,
    -- The id the row had in pickup_releases. Not a foreign key: that row is
    -- gone, and a new release for the same child and day may reuse the slot.
    release_id INTEGER NOT NULL,
    child_id INTEGER NOT NULL
        REFERENCES public.children(id) ON DELETE CASCADE,
    person_id INTEGER
        REFERENCES public.authorized_pickup_people(id) ON DELETE SET NULL,
    person_name TEXT NOT NULL,
    person_relationship TEXT,
    counselor_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    counselor_name TEXT NOT NULL,
    release_date TEXT NOT NULL,
    released_at TIMESTAMP,
    signature BYTEA,
    signature_mime TEXT,
    voided_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    voided_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    voided_by_name TEXT NOT NULL,
    void_reason TEXT NOT NULL CHECK (btrim(void_reason) <> '')
);

CREATE INDEX IF NOT EXISTS idx_pickup_release_voids_date
    ON public.pickup_release_voids(release_date);

COMMIT;
