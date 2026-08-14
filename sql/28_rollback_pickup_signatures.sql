-- =============================================================================
-- kikar-afterschool — Phase 27 ROLLBACK: Drop pickup signatures
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that writes and reads these columns
--   has been reverted. While the deployed code still requires a signature,
--   dropping the column makes every release fail on INSERT, which takes the
--   counselor's release flow down entirely.
--
--   Also remove the two ADD COLUMN statements from init_db() in
--   server/database.py, or the next boot puts the columns straight back.
--
-- WHAT YOU LOSE
--   Every signature ever captured, permanently. The bytes live nowhere else —
--   there is no bucket copy and no export that carries them. The rest of the
--   release record survives: which child, who collected them, the
--   relationship, the counselor and the time all stay, because those are
--   separate columns. What goes is the proof.
--
--   If the signatures may ever be needed — a custody question, an incident
--   review — extract them first. This writes one PNG per release into a
--   directory the Postgres server can write to:
--
--     SELECT r.id, c.name AS child, r.person_name, r.released_at,
--            encode(r.signature, 'base64') AS signature_b64
--       FROM public.pickup_releases r
--       JOIN public.children c ON c.id = r.child_id
--      WHERE r.signature IS NOT NULL
--      ORDER BY r.released_at;
--
--   Keep the base64 output somewhere durable before running the drop below.
--
-- WHAT STAYS
--   attendance_records.checked_out_at is untouched. So is every other column
--   on pickup_releases, and so is authorized_pickup_people.
-- =============================================================================

BEGIN;

ALTER TABLE public.pickup_releases DROP COLUMN IF EXISTS signature;
ALTER TABLE public.pickup_releases DROP COLUMN IF EXISTS signature_mime;

-- Sanity check — should return 0 rows.
SELECT column_name FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'pickup_releases'
  AND column_name IN ('signature', 'signature_mime');

COMMIT;
