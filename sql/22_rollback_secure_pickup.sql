-- =============================================================================
-- kikar-afterschool — Phase 21 ROLLBACK: Drop secure pickup
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes these tables has
--   been reverted, and after the `secure_pickup` module has been turned off
--   for every organization — otherwise the counselor's Today screen errors
--   trying to load the authorized list.
--
--   Also remove 'authorized_pickup_people' and 'pickup_releases' from
--   TENANT_TABLES in server/tenancy.py, or the next boot recreates the
--   organization_id column on tables that no longer exist and fails.
--
-- WHAT YOU LOSE
--   The entire release log: who collected which child, when, and which
--   counselor confirmed it. That record exists nowhere else. If it may ever be
--   needed — a custody question, an incident review — export it first:
--
--     SELECT c.name AS child, r.person_name, r.person_relationship,
--            r.counselor_name, r.released_at
--       FROM public.pickup_releases r
--       JOIN public.children c ON c.id = r.child_id
--      ORDER BY r.released_at;
--
--   attendance_records.checked_out_at keeps whatever the releases stamped;
--   dropping these tables does not clear it. The times survive, the record of
--   who does not.
--
-- ORDER
--   pickup_releases first: it references authorized_pickup_people.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.pickup_releases;
DROP TABLE IF EXISTS public.authorized_pickup_people;

-- Sanity check — should return 0 rows.
SELECT tablename FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('authorized_pickup_people','pickup_releases');

COMMIT;
