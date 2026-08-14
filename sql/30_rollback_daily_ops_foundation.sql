-- =============================================================================
-- kikar-afterschool — Phase 29 ROLLBACK: Drop the daily operations foundation
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes these tables has
--   been reverted, and after the `daily_ops` module has been turned off for
--   every organization — otherwise the roster import screen errors on load.
--
--   Also, and first:
--
--     • Remove the seven table names from TENANT_TABLES in server/tenancy.py,
--       or the next boot tries to add organization_id to tables that no longer
--       exist and fails before it reaches anything else.
--     • Remove the ('rooms', …) and ('school_aliases', …) entries from
--       PER_ORG_UNIQUES in the same file, for the same reason.
--     • Remove the matching DDL from init_db() in server/database.py, or the
--       next boot puts all of it straight back.
--
-- WHAT YOU LOSE
--   This is the destructive one in this feature, and it is worth reading twice.
--   Dropping these tables and columns discards, for every child in the JCC:
--
--     • date of birth, sex, grade, allergies, and free-text notes
--     • both parent contacts — name, phone and email for each
--     • the entire registration and medical paperwork checklist
--     • every dismissal time, and with it the whole basis of the sign-out
--       sheet, the bus manifest and the care-room routing
--     • the care rooms and the grade rules that fill them
--
--   Once the JCC stops maintaining the spreadsheet by hand, this database is
--   the only place that data lives. Export it before running this file:
--
--     SELECT c.id, c.name, c.grade_label, c.dob, c.sex, c.allergies,
--            c.bus_rider, c.arrival_mode, c.notes,
--            k.priority, k.name AS contact_name, k.phone, k.email
--       FROM public.children c
--       LEFT JOIN public.child_contacts k ON k.child_id = c.id
--      ORDER BY c.id, k.priority;
--
--     SELECT child_id, day_of_week, dismissal_time
--       FROM public.registrations ORDER BY child_id, day_of_week;
--
--     SELECT child_id, item, status, recorded_on, raw_value
--       FROM public.child_compliance ORDER BY child_id, item;
--
-- WHAT STAYS
--   children, registrations, users, schools and every other table keep working
--   exactly as they did before phase 29 — this only removes what that phase
--   added. children.active, children.parent_id and the existing
--   /api/admin/upload-roster importer are untouched, so the other JCCs are
--   unaffected either way.
--
--   Withdrawn children stay withdrawn: withdrawn_at and withdrawn_reason are
--   dropped, but children.active is not, and active is what every query reads.
--
-- ORDER
--   Tables go in reverse dependency order — rows before batches, rules before
--   rooms — so no FK blocks the drop. The columns go last.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. The staged imports, then the batches they belong to.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.roster_import_rows;
DROP TABLE IF EXISTS public.roster_import_batches;

-- -----------------------------------------------------------------------------
-- 2. The care rules, then the rooms they point at.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.care_assignment_rules;
DROP TABLE IF EXISTS public.rooms;

-- -----------------------------------------------------------------------------
-- 3. The per-child side tables.
-- -----------------------------------------------------------------------------
DROP TABLE IF EXISTS public.child_compliance;
DROP TABLE IF EXISTS public.child_contacts;
DROP TABLE IF EXISTS public.school_aliases;

-- -----------------------------------------------------------------------------
-- 4. registrations.dismissal_time. Dropping the column takes its CHECK with it.
-- -----------------------------------------------------------------------------
ALTER TABLE public.registrations DROP COLUMN IF EXISTS dismissal_time;

-- -----------------------------------------------------------------------------
-- 5. The children columns.
-- -----------------------------------------------------------------------------
ALTER TABLE public.children DROP COLUMN IF EXISTS first_name;
ALTER TABLE public.children DROP COLUMN IF EXISTS last_name;
ALTER TABLE public.children DROP COLUMN IF EXISTS grade_label;
ALTER TABLE public.children DROP COLUMN IF EXISTS grade_num;
ALTER TABLE public.children DROP COLUMN IF EXISTS dob;
ALTER TABLE public.children DROP COLUMN IF EXISTS sex;
ALTER TABLE public.children DROP COLUMN IF EXISTS allergies;
ALTER TABLE public.children DROP COLUMN IF EXISTS bus_rider;
ALTER TABLE public.children DROP COLUMN IF EXISTS notes;
ALTER TABLE public.children DROP COLUMN IF EXISTS arrival_mode;
ALTER TABLE public.children DROP COLUMN IF EXISTS roster_flag;
ALTER TABLE public.children DROP COLUMN IF EXISTS withdrawn_at;
ALTER TABLE public.children DROP COLUMN IF EXISTS withdrawn_reason;

-- -----------------------------------------------------------------------------
-- 6. Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT tablename
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
      'school_aliases', 'child_contacts', 'child_compliance', 'rooms',
      'care_assignment_rules', 'roster_import_batches', 'roster_import_rows'
  );

COMMIT;
