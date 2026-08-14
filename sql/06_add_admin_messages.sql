-- =============================================================================
-- jclub-app — Phase 6: Admin → Parent broadcast messages (Inbox feature)
-- =============================================================================
--
-- WHAT THIS DOES
--   Creates three new tables that power the admin → parent messaging feature:
--     • admin_messages          — one row per composed broadcast.
--     • admin_message_schools   — junction table; populated only when the
--                                 audience is filtered to specific schools.
--     • parent_messages         — per-recipient copy. Each parent gets one row
--                                 they can independently mark read or
--                                 soft-delete without touching other parents'
--                                 inboxes or the admin's source record.
--
--   The Flask app's init_db() also creates these idempotently (CREATE TABLE
--   IF NOT EXISTS) — this file is for environments where DDL is reviewed and
--   applied manually before code rollout.
--
-- WHY THIS IS SAFE
--   • Pure additive change: zero ALTER on any existing table.
--   • All FKs point at existing tables (users, schools) and use ON DELETE
--     CASCADE / SET NULL so referential integrity is automatic.
--   • New rows are written ONLY by new endpoints (/api/admin/messages*,
--     /api/parent/messages*); no existing route is modified.
--   • Re-running this file is safe (CREATE TABLE IF NOT EXISTS, CREATE INDEX
--     IF NOT EXISTS, CREATE POLICY guarded by drop-then-create).
--
-- DEPLOYMENT
--   1. Apply this file in Supabase SQL Editor (BEGIN/COMMIT wrapper makes it
--      all-or-nothing).
--   2. Deploy the Flask + frontend changes. init_db() will see the tables
--      already exist and no-op them.
--   3. Verify: log in as admin → Messages tab; log in as parent → Inbox.
--
-- ROLLBACK
--   See 07_rollback_admin_messages.sql. Drops the three tables in dependency
--   order. Safe to run after reverting the application code.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Source record per composed message.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_messages (
    id            SERIAL PRIMARY KEY,
    sender_id     INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    subject       TEXT NOT NULL,
    body          TEXT NOT NULL,
    audience_type TEXT NOT NULL CHECK (audience_type IN ('all','schools')),
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 2. Audience filter: which schools the message targeted. Empty when
--    audience_type = 'all'.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.admin_message_schools (
    admin_message_id INTEGER NOT NULL REFERENCES public.admin_messages(id) ON DELETE CASCADE,
    school_id        INTEGER NOT NULL REFERENCES public.schools(id) ON DELETE CASCADE,
    PRIMARY KEY (admin_message_id, school_id)
);

-- -----------------------------------------------------------------------------
-- 3. Per-recipient copy. read_at and deleted_at are scoped to one parent so
--    deletes don't affect the admin's send history or other parents.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.parent_messages (
    id               SERIAL PRIMARY KEY,
    admin_message_id INTEGER NOT NULL REFERENCES public.admin_messages(id) ON DELETE CASCADE,
    parent_id        INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    read_at          TIMESTAMP,
    deleted_at       TIMESTAMP,
    created_at       TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- The parent inbox query filters by parent_id + deleted_at IS NULL and
-- orders newest-first; the unread-count query adds read_at IS NULL.
-- This index covers all three.
CREATE INDEX IF NOT EXISTS idx_parent_messages_parent
    ON public.parent_messages(parent_id, deleted_at, read_at);

-- The admin "Recently Sent" view aggregates read_count per admin_message_id.
CREATE INDEX IF NOT EXISTS idx_parent_messages_admin_msg
    ON public.parent_messages(admin_message_id);

-- -----------------------------------------------------------------------------
-- 4. RLS lockdown — match the convention from 01_enable_rls_deny_all.sql.
--    The Flask backend uses the postgres role (BYPASSRLS), so its queries
--    keep working unchanged. PostgREST roles (anon, authenticated) are denied.
-- -----------------------------------------------------------------------------
ALTER TABLE public.admin_messages         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.admin_message_schools  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.parent_messages        ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'admin_messages','admin_message_schools','parent_messages'
    ];
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
-- 5. Sanity check — should return 3 rows, all with rowsecurity = true.
-- -----------------------------------------------------------------------------
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('admin_messages','admin_message_schools','parent_messages')
ORDER BY tablename;

COMMIT;
