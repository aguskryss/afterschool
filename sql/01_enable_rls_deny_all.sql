-- =============================================================================
-- jclub-app — Phase 1 RLS hardening: ENABLE + deny-all (PostgREST lockdown)
-- =============================================================================
--
-- WHAT THIS DOES
--   Enables Row Level Security on every public-schema table and adds an
--   explicit deny-all policy for the `anon` and `authenticated` PostgREST
--   roles. With RLS enabled and no permissive policy, any query from
--   PostgREST returns zero rows (SELECT) or 401/403 (write).
--
-- WHY THIS IS SAFE FOR THE FLASK BACKEND
--   The Flask app connects via DATABASE_URL using the `postgres` role, which
--   has rolbypassrls = true (Supabase default). RLS is NOT enforced for
--   roles with BYPASSRLS, so the backend's queries continue to return the
--   same rows as before. Verify with:
--     SELECT rolname, rolbypassrls FROM pg_roles WHERE rolname = current_user;
--
-- IMPORTANT — DO NOT use FORCE ROW LEVEL SECURITY here
--   FORCE applies RLS even to the table owner / superuser, which would break
--   the Flask backend. The plain ENABLE is what we want.
--
-- AUDIT NOTE
--   The explicit "deny_all_anon" policies are NOT strictly required (RLS
--   without any policy already denies everything to non-bypass roles), but
--   we add them so:
--     1. Supabase Security Advisor stops flagging "RLS enabled but no
--        policies" as a separate warning.
--     2. Auditors reading the schema see intent, not absence.
--
-- DEPLOYMENT
--   Run in Supabase SQL Editor (which uses the postgres role and BYPASSRLS,
--   so the script itself is unaffected by what it enables). Wrap in a
--   transaction to ensure all-or-nothing.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Enable RLS on every table in the public schema
-- -----------------------------------------------------------------------------

ALTER TABLE public.absences              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activities            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_roster       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_schedules    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.app_settings          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance_records    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.calendar_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.children              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counselor_schools     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invitations           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.login_attempts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_notifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.password_reset_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_claim_audit    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pickup_notifications  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.registrations         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.schools               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_totp             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users                 ENABLE ROW LEVEL SECURITY;

-- -----------------------------------------------------------------------------
-- 2. Explicit deny-all for PostgREST roles
--    Both `anon` (unauthenticated) and `authenticated` (logged-in via Supabase
--    Auth) get nothing. Service-role and postgres bypass RLS entirely.
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
        -- Drop any pre-existing deny policy with the same name so the
        -- script is idempotent (safe to re-run).
        EXECUTE format(
            'DROP POLICY IF EXISTS deny_all_anon ON public.%I',
            t
        );
        EXECUTE format(
            'CREATE POLICY deny_all_anon ON public.%I '
            'AS RESTRICTIVE FOR ALL TO anon, authenticated '
            'USING (false) WITH CHECK (false)',
            t
        );
    END LOOP;
END$$;

-- -----------------------------------------------------------------------------
-- 3. Defense in depth: revoke direct table grants from PostgREST roles.
--    Even if a future "ALTER POLICY" mistake added a permissive policy, the
--    role would still need table-level GRANTs to read/write. Supabase grants
--    these by default during table creation; we revoke them explicitly.
--    The `postgres` and `service_role` roles keep their grants.
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
            'REVOKE ALL ON public.%I FROM anon, authenticated',
            t
        );
    END LOOP;
END$$;

-- -----------------------------------------------------------------------------
-- 4. Sanity check — must return 20 rows, all with rowsecurity = true
-- -----------------------------------------------------------------------------

SELECT
    schemaname,
    tablename,
    rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

-- -----------------------------------------------------------------------------
-- 5. Sanity check — current connection role must have BYPASSRLS
--    If this returns rolbypassrls = false, ABORT THE TRANSACTION.
-- -----------------------------------------------------------------------------

SELECT
    current_user                    AS connected_as,
    rolbypassrls                    AS bypasses_rls,
    rolsuper                        AS is_superuser
FROM pg_roles
WHERE rolname = current_user;

COMMIT;

-- After commit, confirm policies were created (should return 20 rows):
--   SELECT tablename, policyname, cmd, permissive
--   FROM pg_policies
--   WHERE schemaname = 'public' AND policyname = 'deny_all_anon'
--   ORDER BY tablename;
