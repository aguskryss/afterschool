-- =============================================================================
-- kikar-afterschool — Phase 75 ROLLBACK: Drop broadcasts to a class
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code has been reverted:
--
--     • Remove 'admin_message_classes' from TENANT_TABLES (server/tenancy.py)
--       and its CREATE TABLE and CHECK change from init_db()
--       (server/database.py), or the next boot puts them back.
--     • Revert the 'classes' audience in server/app.py and the class picker in
--       web/src/routes/admin/Program.tsx and Photos.tsx.
--
-- WHAT YOU LOSE
--   Nothing parents can see: every parent_messages copy stays in their inbox.
--   Messages sent to classes are relabeled audience_type = 'all' in the admin
--   list, because the narrowed CHECK has no other value that fits them —
--   check how many first:
--
--     SELECT count(*) FROM public.admin_messages WHERE audience_type = 'classes';
-- =============================================================================

BEGIN;

UPDATE public.admin_messages SET audience_type = 'all'
 WHERE audience_type = 'classes';

DROP TABLE IF EXISTS public.admin_message_classes;

ALTER TABLE public.admin_messages
    DROP CONSTRAINT IF EXISTS admin_messages_audience_type_check;
ALTER TABLE public.admin_messages
    ADD CONSTRAINT admin_messages_audience_type_check
    CHECK (audience_type IN ('all','schools'));

COMMIT;
