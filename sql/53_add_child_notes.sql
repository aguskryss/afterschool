-- =============================================================================
-- kikar-afterschool — Phase 53: Private admin notes on a child
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds `child_notes`: a running, timestamped log of notes an admin writes
--   about a child, each carrying who wrote it and when.
--
-- WHY NOT A COLUMN ON `children`
--   `children.notes` already exists, and it already rides along in
--   /api/counselor/roster's SELECT — no counselor screen renders it today,
--   but the data itself already reaches that response. Reusing it for
--   something meant to stay admin-only (a custody note, a behavioral
--   concern, anything a family told the office in confidence) would be one
--   future counselor screen away from leaking it. A separate table is never
--   selected into a counselor- or parent-facing response anywhere in
--   app.py — every route touching child_notes is require_admin() — which
--   makes "admin-only" a property of the schema, not a habit every future
--   query has to remember to keep up.
--
-- WHY A LOG, NOT ONE FIELD
--   `children.notes` is a single overwritable box. A note about a child is
--   usually one entry in an ongoing situation — who wrote it and when
--   matters as much as the text, the same reason every other record in this
--   app (absences, releases, staff messages) keeps who and when rather than
--   just a current value.
--
-- TENANCY
--   Registered in TENANT_TABLES (server/tenancy.py); init_db() adds
--   organization_id, its default, FK, index and RLS policies on the next
--   boot. Do not add those here.
--
-- DEPLOYMENT
--   1. Apply this file in the Supabase SQL Editor.
--   2. Deploy the application. No module toggle — this is core, like the
--      rest of the child profile screen.
--   3. Verify: as an admin, open a child's profile, add a note under
--      "Private notes", and confirm it does not appear anywhere a counselor
--      or parent can see (/api/counselor/roster, /api/parent/children).
--
-- ROLLBACK
--   See 54_rollback_child_notes.sql.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.child_notes (
    id           SERIAL PRIMARY KEY,
    child_id     INTEGER NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
    author_id    INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    author_name  TEXT NOT NULL,
    body         TEXT NOT NULL,
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_child_notes_child
    ON public.child_notes (child_id, created_at DESC);

-- Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
-- per-organization policy is installed by init_db().
ALTER TABLE public.child_notes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS deny_all_anon ON public.child_notes;
CREATE POLICY deny_all_anon ON public.child_notes
    AS RESTRICTIVE FOR ALL TO anon, authenticated
    USING (false) WITH CHECK (false);
REVOKE ALL ON public.child_notes FROM anon, authenticated;

-- Sanity check — should return 1 row, rls_enabled = true.
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'child_notes';

COMMIT;
