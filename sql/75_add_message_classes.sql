-- =============================================================================
-- kikar-afterschool — Phase 75: Broadcasts to a class
-- =============================================================================
--
-- WHAT THIS DOES
--   Lets an admin send an announcement to the families of one or more classes
--   (class_sessions), on any weekday — not only today's.
--
--   • admin_messages.audience_type gains 'classes'.
--   • admin_message_classes — junction table, populated only when
--     audience_type = 'classes' (the twin of admin_message_schools).
--
--   Recipients are the parents (Contact #1 and linked Contact #2) of active
--   children with a class_enrollments row in any chosen class.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • 'admin_message_classes' goes in TENANT_TABLES (server/tenancy.py), which
--     adds organization_id, its FK, its index and the org_isolation policy. Do
--     NOT add those columns here.
--   • init_db() mirrors the CREATE TABLE and the CHECK change, so a deploy that
--     boots before this file is applied converges anyway.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.admin_message_classes (
    admin_message_id INTEGER NOT NULL
        REFERENCES public.admin_messages(id) ON DELETE CASCADE,
    class_session_id INTEGER NOT NULL
        REFERENCES public.class_sessions(id) ON DELETE CASCADE,
    PRIMARY KEY (admin_message_id, class_session_id)
);

ALTER TABLE public.admin_messages
    DROP CONSTRAINT IF EXISTS admin_messages_audience_type_check;
ALTER TABLE public.admin_messages
    ADD CONSTRAINT admin_messages_audience_type_check
    CHECK (audience_type IN ('all','schools','classes'));

COMMIT;
