-- =============================================================================
-- kikar-afterschool — Phase 67: A name is what makes an album real
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds `photos.album_name`, nullable. sql/65 gave every photo an
--   `album_id` — even a lone upload, an album of one — purely so a bulk
--   upload could be dedup'd into one notification per family instead of one
--   per photo. That grouping is invisible; nothing about it says a batch of
--   ten unrelated catch-up photos should read as ONE curated post.
--
--   `album_name` is that opt-in signal, and only that. NULL means "just a
--   batch that happened to upload together" — displayed as ordinary
--   individual photos, same as before sql/65 existed. Set means a real,
--   named, browsable album — shown as one grouped card in the admin's grid
--   and one named section in a parent's gallery.
--
-- WHY NOT A BOOLEAN `is_album` COLUMN ALONGSIDE IT
--   A boolean whose only job is announcing that a text column is filled in
--   is a second copy of the same fact, and the two can disagree — `is_album
--   = true` with `album_name = NULL`, or the reverse, and now every reader
--   has to decide which one to trust. `album_name IS NOT NULL` already says
--   everything `is_album` would, once and unambiguously.
--
-- WHY EVERY PHOTO IN THE ALBUM CARRIES THE NAME, NOT JUST THE ROOT
--   Reading a display name would otherwise mean following `album_id` back
--   to its root row on every read. Every photo in one batch already gets
--   the same caption and the same date for the same reason (the upload form
--   asks once); the name is asked once too, so it is written the same way.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • The matching `ALTER TABLE ... ADD COLUMN IF NOT EXISTS album_name`
--     goes in init_db() (server/database.py), right after sql/65's
--     album_id column, so a database that never ran this file converges.
--   • server/app.py's photo upload/list endpoints read and write it.
--   • web/src/routes/admin/Photos.tsx, web/src/routes/counselor/Photos.tsx
--     and web/src/routes/parent/Photos.tsx draw the checkbox, the name
--     field, and the named-album groupings.
-- =============================================================================

BEGIN;

ALTER TABLE public.photos
    ADD COLUMN IF NOT EXISTS album_name TEXT;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 1 row naming the new column.
-- -----------------------------------------------------------------------------
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'photos'
  AND column_name = 'album_name';

COMMIT;
