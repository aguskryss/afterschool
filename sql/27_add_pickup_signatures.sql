-- =============================================================================
-- kikar-afterschool — Phase 27: Pickup signatures
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds two nullable columns to pickup_releases so the person collecting a
--   child signs for them:
--
--     • signature       — the signature image bytes, a PNG drawn on the
--                         counselor's device.
--     • signature_mime  — the content type of those bytes, always 'image/png'
--                         today. Stored rather than assumed so a future format
--                         does not require guessing at the old rows.
--
-- WHAT THIS DOES NOT DO
--   It does not add a table, and it does not touch authorized_pickup_people,
--   pickup_notifications or attendance_records. The release flow, its
--   UNIQUE (child_id, release_date) and the checked_out_at stamp all keep
--   working exactly as they do today; a release simply now carries its proof.
--
-- WHY THE BYTES LIVE IN POSTGRES AND NOT IN SUPABASE STORAGE
--   The photos module (sql/25) puts image bytes in a bucket and keeps only the
--   path here. That is right for photos and wrong for this, for two reasons:
--
--     1. A release is written inside one transaction that also closes the
--        child's attendance. An object store cannot join that transaction, so
--        the bytes would have to be uploaded first and compensated for on
--        failure — leaving a window where a release exists with no signature,
--        or a signature exists with no release. This row is the record that
--        answers "who took my daughter home"; the two halves must never come
--        apart.
--     2. photo_storage refuses to work when SUPABASE_URL / SUPABASE_SERVICE_KEY
--        are unset, and the photos endpoints return 503. That failure mode is
--        acceptable for a gallery. It is not acceptable for the flow a
--        counselor needs in the carpool line, and it must never be the reason
--        a child cannot be released.
--
--   The cost is database size. A signature is a monochrome PNG of a few
--   hundred strokes — roughly 5–10 KB. At 200 children collected daily that is
--   on the order of 250 MB a year, which is a trade worth making for a record
--   that has to survive.
--
-- WHY THE COLUMNS ARE NULLABLE
--   The application requires a signature: POST /api/counselor/pickup/release
--   refuses without one. The column still allows NULL because rows written
--   before this migration have no signature and a NOT NULL would reject them.
--   `signature IS NULL` is how the admin log tells a pre-signature release
--   from a signed one, and it reports it as such rather than showing an empty
--   frame.
--
-- WHY THERE IS NO deny_all_anon BLOCK
--   pickup_releases was locked against the PostgREST roles in
--   sql/21_add_secure_pickup.sql and stays locked — the policy is on the
--   table, not on its columns. Adding a column does not reopen it.
--
-- TENANCY
--   Nothing to do. pickup_releases is already in TENANT_TABLES
--   (server/tenancy.py), so it already carries organization_id, its default,
--   FK, index and RLS policy. Do not add those here.
--
-- WHY THIS IS SAFE
--   • Purely additive: two nullable columns, no data rewritten, no constraint
--     added to existing rows.
--   • ADD COLUMN with no default does not rewrite the table in PostgreSQL 11+,
--     so this is a metadata-only change even on a long release history.
--   • Re-running is safe (IF NOT EXISTS).
--   • init_db() applies the same two statements on boot, so an environment
--     that deploys before this file is applied converges anyway.
--
-- ORDERING
--   Apply after 21_add_secure_pickup.sql, which creates the table.
--
-- DEPLOYMENT
--   1. Apply this file in the Supabase SQL Editor.
--   2. Deploy the application.
--   3. Verify: as a counselor, release a child and sign. Then
--        SELECT child_id, person_name, person_relationship, released_at,
--               octet_length(signature) AS sig_bytes, signature_mime
--          FROM pickup_releases ORDER BY released_at DESC LIMIT 5;
--      sig_bytes should be a few thousand, not NULL and not zero.
--
-- ROLLBACK
--   See 28_rollback_pickup_signatures.sql.
-- =============================================================================

BEGIN;

ALTER TABLE public.pickup_releases
    ADD COLUMN IF NOT EXISTS signature BYTEA;

ALTER TABLE public.pickup_releases
    ADD COLUMN IF NOT EXISTS signature_mime TEXT;

-- Sanity check — should return both columns, is_nullable = YES.
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'pickup_releases'
  AND column_name IN ('signature', 'signature_mime')
ORDER BY column_name;

COMMIT;
