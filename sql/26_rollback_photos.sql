-- =============================================================================
-- kikar-afterschool — Phase 25 ROLLBACK: Drop daily photos
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code has been reverted and the `photos`
--   module turned off for every organization.
--
--   Also remove 'photos' and 'photo_tags' from TENANT_TABLES in
--   server/tenancy.py, or the next boot tries to add organization_id to tables
--   that no longer exist and fails.
--
-- THIS DOES NOT EMPTY THE BUCKET
--   Dropping these rows deletes the only index of what is in Supabase Storage.
--   The image files stay there, now unreferenced and unreachable through the
--   app — still billable, and still photographs of children sitting in a
--   bucket nobody is tracking.
--
--   Export the paths BEFORE running this, or the objects can only be found by
--   listing the bucket:
--
--     SELECT storage_path, photo_date FROM public.photos ORDER BY photo_date;
--
--   Then delete the org-<id>/ prefixes from the bucket by hand.
--
-- ORDER
--   photo_tags first: it references photos.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.photo_tags;
DROP TABLE IF EXISTS public.photos;

-- Sanity check — should return 0 rows.
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('photos','photo_tags');

COMMIT;
