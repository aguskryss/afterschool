-- =============================================================================
-- kikar-afterschool — Phase 51: Two-way staff (counselor) ↔ admin messaging
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds the two tables behind the `staff_messaging` module:
--
--     • staff_threads          — one conversation per counselor, carrying the
--                                unread counts for both sides.
--     • staff_thread_messages  — the messages in it, from either side.
--
-- WHY NOT REUSE parent_threads / thread_messages
--   Same shape (one thread per person, both directions), but
--   thread_messages.sender_role is CHECK-constrained to ('parent','admin') and
--   thread_messages.thread_id references parent_threads specifically. A
--   counselor is neither side of that conversation, and folding staff messages
--   into the family inbox would put a counselor's note about tomorrow's
--   schedule on the same screen the admin reads a parent's pickup question
--   from. Mirrors 23_add_parent_messaging.sql exactly, one level down.
--
-- WHO CAN WRITE
--   A counselor can only message the admin — there is no thread between two
--   counselors, and no way for a counselor to reach a parent from here. The
--   server enforces this (counselor_get/send_conversation check
--   claims['role'] == 'counselor'), not this schema, the same way
--   parent_threads doesn't stop a parent row from existing — the CHECK on
--   sender_role is the only constraint the database itself holds.
--
-- TENANCY
--   Both tables are registered in TENANT_TABLES (server/tenancy.py); init_db()
--   adds organization_id, its default, FK, index and RLS policies on the next
--   boot. Do not add those here.
--
-- DEPLOYMENT
--   1. Apply this file in the Supabase SQL Editor.
--   2. Deploy the application.
--   3. Enable `staff_messaging` for the organization from the superadmin
--      console.
--   4. Verify: as a counselor, send a message from Account → Message the
--      office; the admin sees it under Conversations → Staff and can reply.
--
-- ROLLBACK
--   See 52_rollback_staff_messaging.sql.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.staff_threads (
    id                SERIAL PRIMARY KEY,
    counselor_id      INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    last_message_at   TIMESTAMP,
    counselor_unread  INTEGER NOT NULL DEFAULT 0,
    admin_unread      INTEGER NOT NULL DEFAULT 0,
    created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (counselor_id)
);

CREATE TABLE IF NOT EXISTS public.staff_thread_messages (
    id           SERIAL PRIMARY KEY,
    thread_id    INTEGER NOT NULL REFERENCES public.staff_threads(id) ON DELETE CASCADE,
    sender_id    INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    sender_role  TEXT NOT NULL CHECK (sender_role IN ('counselor','admin')),
    sender_name  TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_staff_thread_messages_thread
    ON public.staff_thread_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_staff_threads_recent
    ON public.staff_threads (last_message_at DESC NULLS LAST);

-- Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
-- per-organization policies are installed by init_db().
ALTER TABLE public.staff_threads         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.staff_thread_messages ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY['staff_threads','staff_thread_messages'];
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

-- Sanity check — should return 2 rows, all with rls_enabled = true.
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('staff_threads','staff_thread_messages')
ORDER BY tablename;

COMMIT;
