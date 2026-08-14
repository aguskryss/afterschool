-- =============================================================================
-- kikar-afterschool — Phase 39: Class hours come from the roster after all
-- =============================================================================
--
-- WHAT THIS DOES
--   Re-keys class_sessions so a class is identified by
--   (organization, name, weekday, start time) instead of
--   (organization, name, weekday).
--
--   No columns change. start_time and end_time already exist and are already
--   nullable; what changes is that the importer now fills them, and that two
--   classes may share a name and a weekday if they start at different times.
--
-- WHY — sql/35 STATED AN ASSUMPTION THAT THE REAL FILE FALSIFIED
--   Phase 35 says, in its own words:
--
--     "The roster spreadsheet names the classes but never gives their hours:
--      the M/T/W/R/F class columns hold "Chess", not "Chess 3:00–3:45". So the
--      importer can create the catalog but cannot fill it in."
--
--   That was true of the file available when it was written. Heather's actual
--   roster (`J Adv Spring Roster 2025-26.xlsx`) writes the hours into the name:
--
--     Soccer 3:15p-4p      HW Club 4p-5p       Swim T (Mini Black) 3:45p-5p
--
--   46 of the 48 distinct class strings in it carry a readable time range; the
--   two that do not are `NO CLASS` and `BUS ONLY - EHS`, which are not classes.
--   roster_import.parse_class_cell now splits name from hours, and
--   roster_staging stores both.
--
--   This is not a convenience. R2 routes a child by comparing the class end
--   against their dismissal time, so a class with no end_time has no computable
--   destination and §6.3 makes the board warn about the child. The hours were
--   sitting in the file the whole time, unread.
--
-- WHY THE KEY HAS TO GROW
--   Once the hours are split off the name, the old key collides. In the spring
--   roster there are eight cases of one class running twice on the same day:
--
--     HW Club 3p-4p   and  HW Club 4p-5p    — Tuesday and Thursday
--     Pvt Swim 3p-3:30p / 3:30p-4p / 4p-4:30p
--     Swim L3, KIM (Hip Hop), Soccer        — likewise
--
--   These are different classes: different rosters, different counselors,
--   different rooms. UNIQUE (name, day_of_week) folds each pair into one row
--   and silently merges two rosters into one.
--
-- WHY AN INDEX AND NOT A CONSTRAINT
--   start_time is nullable — a class can still be added by hand before anyone
--   knows its hours — and in a unique constraint a NULL is distinct from every
--   other NULL, so two such rows would both be accepted and the catalog would
--   grow duplicates. A unique index over COALESCE(start_time, '00:00') makes
--   the absent case a single value. Midnight is never a real after-school
--   class, so the sentinel cannot collide with one.
--
--   staff_assignments already does exactly this, for exactly this reason
--   (server/database.py, `staff_assignments_class_unique`).
--
-- WHY lower(name)
--   A gap that predates this change: roster_staging looks a class up with
--   `lower(name) = lower(%s)` while the constraint was case-sensitive, so
--   `Chess` and `CHESS` could both exist and the lookup found whichever row
--   came first. Folding the case in the index makes the two agree.
--
-- BEFORE YOU RUN THIS
--   If any organization already has two classes that differ only in case —
--   `Chess` and `CHESS` on the same weekday and hour — the index will not
--   build. Find them first:
--
--     SELECT organization_id, lower(name), day_of_week,
--            COALESCE(start_time, TIME '00:00') AS start, count(*)
--       FROM class_sessions
--      GROUP BY 1, 2, 3, 4 HAVING count(*) > 1;
--
--   Merge each pair by hand (move class_enrollments to the survivor, then
--   delete the duplicate) before applying. On a database where the roster
--   importer has only ever created classes this returns no rows.
--
-- MIRRORED IN init_db()
--   Per §6 of CLAUDE.md, the same statements run idempotently from
--   server/database.py, so a deploy that predates this file converges anyway.
--   tenancy.PER_ORG_UNIQUES no longer lists class_sessions; the index below
--   replaces the constraint that loop used to build.
--
-- ROLLBACK
--   sql/40_rollback_class_session_times.sql — and read its warning first: going
--   back requires deleting real rows.
-- =============================================================================

BEGIN;

-- The pre-tenancy constraint, and the per-organization one PER_ORG_UNIQUES
-- built from it. Either, both or neither may exist depending on how far this
-- database has been migrated; all three statements are safe to re-run.
ALTER TABLE class_sessions
    DROP CONSTRAINT IF EXISTS class_sessions_name_day_of_week_key;
ALTER TABLE class_sessions
    DROP CONSTRAINT IF EXISTS class_sessions_org_unique;

CREATE UNIQUE INDEX IF NOT EXISTS class_sessions_org_unique
    ON class_sessions (organization_id, lower(name), day_of_week,
                       COALESCE(start_time, TIME '00:00'));

COMMIT;
