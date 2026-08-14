-- =============================================================================
-- kikar-afterschool — Rollback of Phase 43
-- =============================================================================
--
-- WHAT THIS RESTORES
--   Logos come only from `logo_url` again — a link to an image hosted
--   somewhere else. Organizations that had uploaded one fall back to whatever
--   `logo_url` holds, which for most of them is NULL, so the app shows the
--   Kikar wordmark instead.
--
-- THE OBJECTS ARE NOT DELETED, AND THAT IS DELIBERATE
--   Dropping the column discards the only record of which object belongs to
--   which organization, but the files stay in the `brand` bucket. That is the
--   safe direction: a rollback that also deleted the images would make going
--   forward again mean asking every JCC to re-upload a logo they already gave
--   us.
--
--   It does mean orphans. If this rollback is permanent rather than a bad
--   deploy being backed out, read the paths out FIRST so the bucket can be
--   cleaned by hand afterwards:
--
--     SELECT id, slug, logo_path
--       FROM organizations
--      WHERE logo_path IS NOT NULL;
--
-- REVERTING THE CODE IS REQUIRED
--   server/app.py and server/superadmin.py select logo_path by name, and
--   server/tenancy.py re-adds it on the next boot. Revert the application
--   first, then run this file.
-- =============================================================================

BEGIN;

ALTER TABLE organizations DROP COLUMN IF EXISTS logo_path;

COMMIT;
