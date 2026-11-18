-- =============================================================================
-- kikar-afterschool — Phase 79: Cancel a class for one day
-- =============================================================================
--
-- WHAT THIS DOES
--   Lets an admin call off one class on one date (staffing, a sick
--   instructor, anything) without touching its enrollments. On that date the
--   class does not exist for the routing engine:
--
--     • its children wait in the care room their grade is assigned to for
--       those hours, exactly as if they had no class;
--     • a class right before it dismisses them to care instead;
--     • whoever was staffing it is free that day.
--
--   The next week the class is simply back, with the same roster. Parents are
--   not notified.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • 'class_cancellations' goes in TENANT_TABLES (server/tenancy.py), which
--     adds organization_id, its FK, its index and the org_isolation policy. Do
--     NOT add those columns here.
--   • init_db() mirrors the CREATE TABLE, so a deploy that boots before this
--     file is applied converges anyway.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.class_cancellations (
    id SERIAL PRIMARY KEY,
    class_session_id INTEGER NOT NULL
        REFERENCES public.class_sessions(id) ON DELETE CASCADE,
    cancel_date DATE NOT NULL,
    reason TEXT,
    cancelled_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    cancelled_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- class_session_id is already per-organization, so this needs no
    -- organization_id to be correct across tenants.
    UNIQUE (class_session_id, cancel_date)
);

CREATE INDEX IF NOT EXISTS idx_class_cancellations_date
    ON public.class_cancellations (cancel_date);

COMMIT;
