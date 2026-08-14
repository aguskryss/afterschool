-- =============================================================================
-- jclub-app — Rollback for Phase 6: drop the admin → parent messages tables
-- =============================================================================
--
-- WHAT THIS DOES
--   Drops the three tables created by 06_add_admin_messages.sql in dependency
--   order:
--     1. parent_messages         (depends on admin_messages, users)
--     2. admin_message_schools   (depends on admin_messages, schools)
--     3. admin_messages          (root)
--
-- WHEN TO RUN THIS
--   Only after the application code that references these tables has been
--   reverted. If the Flask backend is still on a build that calls the
--   /api/admin/messages or /api/parent/messages endpoints, those calls will
--   start returning 500s the moment this rollback completes.
--
--   Order of operations for a safe rollback:
--     1. Revert the frontend + backend commits (or roll back the Render
--        deployment to the previous image).
--     2. Verify the app no longer hits /api/(admin|parent)/messages*.
--     3. Run this file in Supabase SQL Editor.
--
-- DATA LOSS WARNING
--   This permanently deletes every row in admin_messages, admin_message_schools,
--   and parent_messages. If you need to preserve the message history for
--   audit, take a backup first:
--
--     CREATE TABLE backup_admin_messages_YYYYMMDD AS TABLE admin_messages;
--     CREATE TABLE backup_admin_message_schools_YYYYMMDD AS TABLE admin_message_schools;
--     CREATE TABLE backup_parent_messages_YYYYMMDD AS TABLE parent_messages;
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.parent_messages         CASCADE;
DROP TABLE IF EXISTS public.admin_message_schools   CASCADE;
DROP TABLE IF EXISTS public.admin_messages          CASCADE;

-- Sanity check — should return 0 rows.
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('admin_messages','admin_message_schools','parent_messages');

COMMIT;
