-- =============================================================================
-- kikar-afterschool — Rollback of Phase 39
-- =============================================================================
--
-- READ THIS BEFORE RUNNING IT
--   This rollback is not symmetric with the migration, and cannot be. Phase 39
--   widened the key, so rows that are legal after it are illegal before it:
--
--     HW Club · Tuesday · 15:00–16:00
--     HW Club · Tuesday · 16:00–17:00
--
--   Both exist in a database that has imported Heather's spring roster, and
--   UNIQUE (name, day_of_week) cannot hold both. Narrowing the key means
--   deciding which one to destroy, along with its class_enrollments and the
--   staff_assignments pointing at it (both cascade). No script should make that
--   choice on its own, so this one refuses instead.
--
--   The block below aborts with a clear message if any such pair exists. To go
--   back you must first merge the duplicates deliberately — for each group,
--   move class_enrollments and staff_assignments onto the row you are keeping
--   and delete the others — and only then re-run this file.
--
--   In practice the reason to run this is a bad deploy caught before an import,
--   when no duplicates exist yet and it completes without complaint.
--
-- WHAT IT RESTORES
--   The per-organization unique on (organization_id, name, day_of_week) that
--   tenancy.PER_ORG_UNIQUES used to build. Reverting the code as well is
--   required: server/tenancy.py must list class_sessions in PER_ORG_UNIQUES
--   again, and server/database.py must stop creating the index.
--
--   start_time and end_time keep whatever values the importer wrote. They were
--   nullable before Phase 39 and are nullable after it, so the data stays
--   valid; the old code simply stops filling them in.
-- =============================================================================

BEGIN;

DO $$
DECLARE
    collisions INTEGER;
    example TEXT;
BEGIN
    SELECT count(*), min(label)
      INTO collisions, example
      FROM (
        SELECT name || ' on ' || day_of_week AS label
          FROM class_sessions
         GROUP BY organization_id, name, day_of_week
        HAVING count(*) > 1
      ) AS duplicated;

    IF collisions > 0 THEN
        RAISE EXCEPTION
            'Cannot narrow the class_sessions key: % group(s) collide on '
            '(organization, name, weekday) — for example "%". Merge each group '
            'by hand (move class_enrollments and staff_assignments onto the row '
            'you keep, delete the rest), then run this file again.',
            collisions, example;
    END IF;
END $$;

DROP INDEX IF EXISTS class_sessions_org_unique;

ALTER TABLE class_sessions
    ADD CONSTRAINT class_sessions_org_unique
    UNIQUE (organization_id, name, day_of_week);

COMMIT;
