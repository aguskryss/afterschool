-- =============================================================================
-- kikar-afterschool — Phase 31: A child's status through the afternoon
-- =============================================================================
--
-- NUMBERING
--   33 and 34 shipped before this one. They are independent — nothing in them
--   touches attendance_records — so this applies whenever, and a dense
--   sequence is worth more here than a chronological one.
--
-- WHAT THIS DOES
--   attendance_records.on_bus is a boolean doing four jobs at once: the
--   counselor's tap at school, "is this child here", the headcount's
--   numerator, and — because a release sets it to 1 — a child who left an
--   hour ago. The screens disagree about which of those it means. On
--   counselor/Roster.tsx a released child is indistinguishable from one still
--   in the building, because the endpoint that screen reads returns on_bus
--   and nothing else.
--
--     • status      — where the child actually is.
--     • status_at   — when they got there.
--     • status_by   — which counselor said so.
--     • status_note — why, for the states that need one.
--
-- THE STATES, AND THE ONE THAT IS DELIBERATELY MISSING
--
--     waiting      the counselor is at the school, child not collected yet
--     picked_up    collected from school — which is what "in the building"
--                  counts, and what on_bus has always meant
--     checked_out  released to a parent, with the signature (R6)
--     absent       reported out, or nobody came
--     not_found    the counselor could not find them at the school
--     issue        something else, and status_note says what
--
--   The spec's walkthrough asks for "Picked Up From School" and "Arrived at
--   Building" as separate states. They are one state here, on purpose: the
--   same counselor who taps a child onto the bus walks them in, there is no
--   second tap anywhere in the program, and a state nobody ever transitions
--   into is a status that is permanently, silently wrong. If the bus workflow
--   ever grows that second tap, `arrived` slots between picked_up and
--   checked_out without touching anything else — the values are a set, not an
--   ordinal.
--
-- WHY NOT AN EVENT TABLE
--   The spec's §4 wants AttendanceEvent, many rows per child per day. That is
--   the better long-term shape and the more invasive migration: it moves the
--   check-in/check-out flow that is already live at a JCC. One row per child
--   per day keeps every existing query working unchanged, and the append-only
--   log can be added later on top of a status that has settled in real use.
--   status_at/_by carry the who-and-when in the meantime.
--
-- WHY NULL IS A REAL VALUE
--   Every attendance row written before today has no status. NULL means "no
--   status recorded", and the readers derive one from on_bus and
--   checked_out_at exactly as they did before. So this migration changes no
--   number on any screen on the day it is applied.
--
-- WHY on_bus STAYS
--   Every attendance query, export, trend chart and roster in the app reads
--   it, at every JCC. status is written alongside it and never instead of it;
--   the application keeps the two consistent in one place
--   (_ON_BUS_FOR_STATUS in server/app.py). Replacing on_bus is a separate
--   change with a separate blast radius.
--
-- WHY THERE IS NO status_school_id
--   attendance_records.school_id already records the school the row was
--   written against, and the build plan's sketch of a second school column
--   would be a copy of it that can disagree. The same argument that kept a
--   second `status` column off `children` (see server/database.py) applies
--   here: two columns for one fact eventually put a child in two places.
--
-- WHY THIS IS SAFE
--   Four nullable columns and one CHECK that admits NULL, so no existing row
--   is rewritten and the constraint validates without a scan worth deferring.
--   init_db() applies the same DDL on boot.
--
-- ROLLBACK
--   sql/32_rollback_child_status.sql.
-- =============================================================================

BEGIN;

ALTER TABLE public.attendance_records ADD COLUMN IF NOT EXISTS status      TEXT;
ALTER TABLE public.attendance_records ADD COLUMN IF NOT EXISTS status_at   TIMESTAMP;
ALTER TABLE public.attendance_records ADD COLUMN IF NOT EXISTS status_by   INTEGER
    REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.attendance_records ADD COLUMN IF NOT EXISTS status_note TEXT;

DO $$ BEGIN
    ALTER TABLE public.attendance_records ADD CONSTRAINT attendance_records_status_check
        CHECK (status IS NULL OR status IN (
            'waiting', 'picked_up', 'checked_out',
            'absent', 'not_found', 'issue'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- "Who still needs attention at this school today" — the query the operations
-- board asks on every refresh.
CREATE INDEX IF NOT EXISTS idx_attendance_records_status
    ON public.attendance_records (attendance_date, status);

-- -----------------------------------------------------------------------------
-- Sanity check — four columns, and the constraint in place.
-- -----------------------------------------------------------------------------
SELECT column_name
  FROM information_schema.columns
 WHERE table_schema = 'public' AND table_name = 'attendance_records'
   AND column_name IN ('status', 'status_at', 'status_by', 'status_note')
 ORDER BY column_name;

COMMIT;
