-- =============================================================================
-- jclub-app — Phase 1 RLS rollback
-- =============================================================================
--
-- WHEN TO RUN
--   Only if 01_enable_rls_deny_all.sql causes a real production incident.
--   In Plan A this is extremely unlikely because the Flask backend uses a
--   role that bypasses RLS — but this script restores the previous state in
--   under a second so you have an immediate escape hatch.
--
-- WHAT IT DOES
--   1. Drops the deny_all_anon policies
--   2. Disables RLS on every table
--   3. Re-grants table privileges to anon / authenticated to match the
--      pre-migration state (Supabase's default grants on new tables).
--
-- WHAT IT DOES NOT DO
--   It does NOT re-expose data to the public internet beyond where it was
--   before the migration — it just reverts to that prior (insecure) state.
--   So only run this as an emergency unblock; then immediately diagnose
--   and re-apply 01_enable_rls_deny_all.sql.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Drop the deny-all policies
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'absences','activities','activity_roster','activity_schedules',
        'app_settings','attendance_records','calendar_events','children',
        'counselor_schools','invitations','login_attempts','parent_notifications',
        'password_reset_tokens','pickup_claim_audit','pickup_notifications',
        'push_subscriptions','registrations','schools','user_totp','users'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format(
            'DROP POLICY IF EXISTS deny_all_anon ON public.%I',
            t
        );
    END LOOP;
END$$;

-- -----------------------------------------------------------------------------
-- 2. Disable RLS on every table
-- -----------------------------------------------------------------------------

ALTER TABLE public.absences              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities            DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_roster       DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_schedules    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings          DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events       DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.children              DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.counselor_schools     DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations           DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_attempts        DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_notifications  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_tokens DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_claim_audit    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_notifications  DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions    DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.registrations         DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.schools               DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_totp             DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.users                 DISABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 3. Restore Supabase's default table grants for PostgREST roles.
--    Skip this step if you want to keep the table grants revoked even with
--    RLS disabled (recommended — it gives you defense in depth).
-- -----------------------------------------------------------------------------

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'absences','activities','activity_roster','activity_schedules',
        'app_settings','attendance_records','calendar_events','children',
        'counselor_schools','invitations','login_attempts','parent_notifications',
        'password_reset_tokens','pickup_claim_audit','pickup_notifications',
        'push_subscriptions','registrations','schools','user_totp','users'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format(
            'GRANT ALL ON public.%I TO anon, authenticated',
            t
        );
    END LOOP;
END$$;

-- -----------------------------------------------------------------------------
-- 4. Verify rollback — must return 20 rows, all with rowsecurity = false
-- -----------------------------------------------------------------------------

SELECT
    schemaname,
    tablename,
    rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

COMMIT;
