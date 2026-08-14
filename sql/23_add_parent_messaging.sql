-- =============================================================================
-- kikar-afterschool — Phase 23: Two-way parent ↔ admin messaging
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds the two tables behind the `parent_messaging` module:
--
--     • parent_threads   — one conversation per parent, carrying the unread
--                          counts for both sides.
--     • thread_messages  — the messages in it, from either side.
--
-- WHY NOT REUSE admin_messages
--   admin_messages is a broadcast: one announcement fans out to many parents
--   via parent_messages, and a parent can only read, mark read and delete
--   their copy. A conversation is the other shape — one family, both
--   directions, ordered. Folding them together would mean either hanging a
--   reply box off every announcement or pretending a thread has an audience.
--   The broadcast keeps working unchanged under the `messages` module.
--
-- WHY THE UNREAD COUNTS ARE COLUMNS
--   The admin inbox lists every thread at once. Deriving unread with a
--   correlated COUNT(*) per row makes that list scale with total message
--   volume rather than with the number of families. The counts are maintained
--   by the two write paths — send bumps the other side, opening clears your
--   own — both inside the same statement that writes the message.
--
-- TENANCY
--   Both tables are registered in TENANT_TABLES (server/tenancy.py); init_db()
--   adds organization_id, its default, FK, index and RLS policies on the next
--   boot. Do not add those here.
--
-- DEPLOYMENT
--   1. Apply this file in the Supabase SQL Editor.
--   2. Deploy the application.
--   3. Enable `parent_messaging` for the organization from the superadmin
--      console.
--   4. Verify: as a parent, send a message from Inbox → Office; the admin sees
--      the thread with one unread and can reply.
--
-- ROLLBACK
--   See 24_rollback_parent_messaging.sql.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.parent_threads (
    id               SERIAL PRIMARY KEY,
    parent_id        INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    last_message_at  TIMESTAMP,
    parent_unread    INTEGER NOT NULL DEFAULT 0,
    admin_unread     INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (parent_id)
);

CREATE TABLE IF NOT EXISTS public.thread_messages (
    id           SERIAL PRIMARY KEY,
    thread_id    INTEGER NOT NULL REFERENCES public.parent_threads(id) ON DELETE CASCADE,
    sender_id    INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    sender_role  TEXT NOT NULL CHECK (sender_role IN ('parent','admin')),
    sender_name  TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_thread_messages_thread
    ON public.thread_messages (thread_id, created_at);
CREATE INDEX IF NOT EXISTS idx_parent_threads_recent
    ON public.parent_threads (last_message_at DESC NULLS LAST);

-- Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
-- per-organization policies are installed by init_db().
ALTER TABLE public.parent_threads  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thread_messages ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY['parent_threads','thread_messages'];
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
  AND tablename IN ('parent_threads','thread_messages')
ORDER BY tablename;

COMMIT;
