-- =============================================================================
-- kikar-afterschool — Phase 25: Daily photos
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds the two tables behind the `photos` module:
--
--     • photos      — one row per uploaded image: where it lives in storage,
--                     who uploaded it, which day it belongs to.
--     • photo_tags  — which children appear in it.
--
--   The image bytes are NOT in Postgres. They live in a private Supabase
--   Storage bucket; see server/photo_storage.py. These rows hold the path.
--
-- THE ACCESS RULE
--   A parent may see a photo if and only if it is tagged with one of their own
--   children:
--
--     photos → photo_tags → children WHERE children.parent_id = <the parent>
--
--   RLS separates one JCC from another. It does NOT separate one family from
--   another inside a JCC — every parent in an organization can read that
--   organization's rows as far as the policies are concerned. The parent_id
--   filter in the application query is the only thing standing between one
--   family and another family's photographs, which makes it the single most
--   security-relevant line in this feature. tests/test_tenant_isolation.py
--   covers it.
--
--   A photo with no tags is therefore visible to no parent. That is the
--   correct default for an untagged upload, not an oversight.
--
-- WHY THE BUCKET MUST BE PRIVATE
--   Reads go through short-lived signed URLs. A public bucket would make every
--   photo readable by anyone who guesses a path — for photographs of other
--   people's children, that is the failure this whole design avoids.
--
-- STORAGE LAYOUT
--   org-<organization_id>/<YYYY-MM-DD>/<uuid>.<ext>
--   The organization prefix means even a path-handling bug stays inside the
--   tenant that wrote it.
--
-- TENANCY
--   Both tables are in TENANT_TABLES (server/tenancy.py); init_db() adds
--   organization_id, its default, FK, index and policies on the next boot.
--
-- DEPLOYMENT
--   1. Create a PRIVATE bucket (default name 'photos') in Supabase Storage.
--   2. Set SUPABASE_URL, SUPABASE_SERVICE_KEY and SUPABASE_PHOTOS_BUCKET in
--      Render. The service_role key, not the anon key.
--   3. Apply this file, deploy, enable the `photos` module for the org.
--   4. Verify: upload one photo tagged to a single child, then sign in as a
--      different family and confirm the gallery is empty.
--
-- ROLLBACK
--   See 26_rollback_photos.sql. Note it does not empty the storage bucket.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.photos (
    id            SERIAL PRIMARY KEY,
    storage_path  TEXT NOT NULL UNIQUE,
    uploaded_by   INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    photo_date    TEXT NOT NULL,
    caption       TEXT,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.photo_tags (
    photo_id  INTEGER NOT NULL REFERENCES public.photos(id) ON DELETE CASCADE,
    child_id  INTEGER NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
    PRIMARY KEY (photo_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_photos_date ON public.photos (photo_date DESC);
CREATE INDEX IF NOT EXISTS idx_photo_tags_child ON public.photo_tags (child_id);

-- Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
-- per-organization policies are installed by init_db().
ALTER TABLE public.photos     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.photo_tags ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE
    t text;
    tables text[] := ARRAY['photos','photo_tags'];
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
  AND tablename IN ('photos','photo_tags')
ORDER BY tablename;

COMMIT;
