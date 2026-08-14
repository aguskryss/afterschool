-- =============================================================================
-- kikar-afterschool — Phase 23 ROLLBACK: Drop two-way parent messaging
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes these tables has
--   been reverted, and after `parent_messaging` has been turned off for every
--   organization — otherwise the parent Inbox errors on its Office tab.
--
--   Also remove 'parent_threads' and 'thread_messages' from TENANT_TABLES in
--   server/tenancy.py, or the next boot tries to add organization_id to tables
--   that no longer exist and fails.
--
-- WHAT YOU LOSE
--   Every conversation between families and the office. Export first if any of
--   it matters:
--
--     SELECT u.email AS parent, m.sender_role, m.sender_name, m.body, m.created_at
--       FROM public.thread_messages m
--       JOIN public.parent_threads t ON t.id = m.thread_id
--       JOIN public.users u ON u.id = t.parent_id
--      ORDER BY t.id, m.created_at;
--
--   Broadcast announcements are untouched: admin_messages and parent_messages
--   are a different feature under a different module.
--
-- ORDER
--   thread_messages first: it references parent_threads.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.thread_messages;
DROP TABLE IF EXISTS public.parent_threads;

-- Sanity check — should return 0 rows.
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('parent_threads','thread_messages');

COMMIT;
