-- =============================================================================
-- kikar-afterschool — Phase 53 ROLLBACK: Drop private admin notes
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes this table has
--   been reverted — otherwise a child's admin profile errors opening
--   "Private notes".
--
--   Also remove 'child_notes' from TENANT_TABLES in server/tenancy.py, or the
--   next boot tries to add organization_id to a table that no longer exists
--   and fails.
--
-- WHAT YOU LOSE
--   Every private note any admin wrote about any child. Export first if any
--   of it matters:
--
--     SELECT c.name AS child, n.author_name, n.body, n.created_at
--       FROM public.child_notes n
--       JOIN public.children c ON c.id = n.child_id
--      ORDER BY c.name, n.created_at;
--
--   `children.notes` is untouched — it is a different column entirely.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.child_notes;

-- Sanity check — should return 0 rows.
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'child_notes';

COMMIT;
