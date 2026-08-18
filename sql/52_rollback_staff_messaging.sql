-- =============================================================================
-- kikar-afterschool — Phase 51 ROLLBACK: Drop staff ↔ admin messaging
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes these tables has
--   been reverted, and after `staff_messaging` has been turned off for every
--   organization — otherwise a counselor's Account screen errors opening
--   Message the office.
--
--   Also remove 'staff_threads' and 'staff_thread_messages' from TENANT_TABLES
--   in server/tenancy.py, or the next boot tries to add organization_id to
--   tables that no longer exist and fails.
--
-- WHAT YOU LOSE
--   Every conversation between counselors and the office. Export first if any
--   of it matters:
--
--     SELECT u.email AS counselor, m.sender_role, m.sender_name, m.body, m.created_at
--       FROM public.staff_thread_messages m
--       JOIN public.staff_threads t ON t.id = m.thread_id
--       JOIN public.users u ON u.id = t.counselor_id
--      ORDER BY t.id, m.created_at;
--
--   Parent ↔ admin conversations are untouched: parent_threads and
--   thread_messages are a different feature under a different module.
--
-- ORDER
--   staff_thread_messages first: it references staff_threads.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.staff_thread_messages;
DROP TABLE IF EXISTS public.staff_threads;

-- Sanity check — should return 0 rows.
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('staff_threads','staff_thread_messages');

COMMIT;
