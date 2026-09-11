-- =============================================================================
-- kikar-afterschool — Phase 65: Grouping a bulk upload into an album
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds `photos.album_id`, self-referencing `photos(id)`. Every photo lands
--   in exactly one album — even a lone upload, which is an album of one — so
--   nothing downstream has to special-case NULL as "not in an album."
--
-- WHY A SELF-REFERENCE ON THE SAME TABLE, NOT A SEPARATE `photo_albums` TABLE
--   An album has no data of its own beyond what a photo already carries —
--   caption, date, who uploaded it — because every photo in one batch shares
--   all three by construction (the upload form asks once, applies to every
--   file chosen). A separate table would exist only to hold a copy of fields
--   the first photo row already has, and every reader would have to join it
--   to answer "whose caption wins," when the answer is always "the root's."
--
-- WHAT "root" MEANS
--   The first photo inserted in a batch gets `album_id = its own id`. Every
--   other photo uploaded in the same request gets that same id. A batch of
--   one photo is still consistent: its own id, pointing at itself.
--
-- WHY ON DELETE SET NULL, AND WHY THAT IS ACCEPTABLE
--   Deleting the root of an album (the one whose id every sibling points at)
--   would otherwise have to choose between cascading the delete to every
--   sibling — turning "remove this one bad photo" into "silently delete
--   eleven good ones" — or reassigning the album to a survivor, which is
--   real bookkeeping for a rare case. SET NULL instead: the orphaned photos
--   just stop being visually grouped and keep behaving as singles, which is
--   what they would have looked like without this migration at all. No data
--   is lost — only the grouping.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • The matching `ALTER TABLE ... ADD COLUMN IF NOT EXISTS album_id` and
--     its backfill go in init_db() (server/database.py), right after
--     `photos`' own CREATE TABLE, so a database that never ran this file
--     converges on its own boot.
--   • server/app.py's photo upload/list endpoints read and write it.
--   • web/src/routes/admin/Photos.tsx and web/src/routes/counselor/Photos.tsx
--     draw the grouped view and the multi-file picker.
-- =============================================================================

BEGIN;

ALTER TABLE public.photos
    ADD COLUMN IF NOT EXISTS album_id INTEGER REFERENCES public.photos(id)
        ON DELETE SET NULL;

-- Every photo that predates this migration becomes its own one-photo album,
-- so `GROUP BY album_id` never has to treat NULL as a third case.
UPDATE public.photos SET album_id = id WHERE album_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_photos_album ON public.photos(album_id);

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows: nothing should be without an album
-- once the backfill above has run.
-- -----------------------------------------------------------------------------
SELECT count(*) AS photos_without_an_album
FROM public.photos
WHERE album_id IS NULL;

COMMIT;
