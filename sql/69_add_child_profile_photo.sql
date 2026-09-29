-- =============================================================================
-- kikar-afterschool — Phase 69: A profile photo for each child
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds `children.photo_path`, nullable. The object path of the child's
--   profile photo in the PRIVATE photos bucket (server/photo_storage.py), put
--   there by the admin from the child's profile or by the child's own parent
--   from their portal. NULL means no photo, and every screen keeps drawing the
--   initials avatar it always has.
--
-- WHY A PATH AND NOT A URL
--   The bucket is private: these are photographs of children. A stored URL
--   would either be public (readable by anyone who has it) or signed (expired
--   an hour later). Readers sign the path per response instead, in bulk, the
--   same way the daily photo galleries do.
--
-- WHY NOT A ROW IN `photos`
--   `photos` is the daily-photos module: tagged, notified, shown in galleries,
--   and gated behind the `photos` module. A profile photo is none of those —
--   it is how a counselor recognises a child at pickup, which every JCC needs
--   whether or not it bought daily photos.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • The matching `ALTER TABLE ... ADD COLUMN IF NOT EXISTS photo_path` in
--     init_db() (server/database.py).
--   • server/app.py: the upload/remove routes under /api/admin/children and
--     /api/parent/children, and `photo_url` on the roster, the admin children
--     list and profile, and the parent's children list.
--   • server/superadmin.py collects these paths into
--     organization_deletions.photo_paths alongside the daily photos.
-- =============================================================================

BEGIN;

ALTER TABLE public.children
    ADD COLUMN IF NOT EXISTS photo_path TEXT;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 1 row naming the new column.
-- -----------------------------------------------------------------------------
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'children'
  AND column_name = 'photo_path';

COMMIT;
