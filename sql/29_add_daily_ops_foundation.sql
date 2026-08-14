-- =============================================================================
-- kikar-afterschool — Phase 29: Daily operations foundation (JCCSN)
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds the schema behind the `daily_ops` module — the JCC that runs its
--   afternoon off a hand-built 33-sheet workbook. Nothing reads or writes any
--   of this yet; the importer and the derived daily views come next.
--
--     • children               — thirteen columns the roster carries and the
--                                app never had anywhere to put: grade, date of
--                                birth, allergies, both name halves, whether
--                                the child rides the bus, and the withdrawal
--                                trail.
--     • registrations          — dismissal_time. The single most load-bearing
--                                column in the whole feature; see below.
--     • school_aliases         — the roster and the attendance workbook call
--                                the same schools different things.
--     • child_contacts         — the two contacts per child the roster lists.
--     • child_compliance       — the registration/medical paperwork checklist.
--     • rooms                  — care rooms (Ocean, Gym, Playground, …).
--     • care_assignment_rules  — which grades go to which room, per block.
--     • roster_import_batches  — a staged import, so the preview an admin
--     • roster_import_rows       approves is byte-identically what commits.
--
-- WHAT THIS DOES NOT DO
--   It does not touch children.parent_id, children.active, attendance_records,
--   activity_roster, or the existing /api/admin/upload-roster importer. Other
--   JCCs keep every one of those working exactly as they do today. Every column
--   this adds is nullable with no default, so their rows are unchanged and no
--   table is rewritten.
--
-- WHY dismissal_time IS NULLABLE
--   Four dismissal times — 3, 4, 5 and 6pm — are the spine of this JCC's day:
--   the sign-out sheet groups by them, the bus manifest orders by them, and the
--   routing rule that decides whether a child goes to a care room or straight
--   to a waiting parent compares the class end time against them.
--
--   But no other JCC has the concept. Their registrations rows mean "enrolled
--   this weekday" and nothing more. NOT NULL DEFAULT 6 would invent a 6pm
--   pickup for every one of those rows, and the derived views would start
--   quietly asserting something about children nobody said anything about.
--   NULL means "this organization does not use dismissal times" and the views
--   must read it that way — never as 6.
--
--   SMALLINT rather than TIME because the spec is explicit that there are
--   exactly four values. Sign-out grouping is then GROUP BY dismissal_time
--   instead of a string compare, and the cost — a 3:15 dismissal is
--   inexpressible — is a case the spec says cannot happen.
--
-- WHY children GAINS COLUMNS RATHER THAN A SIDE TABLE
--   Every derived view — bus manifest, class roster, care room, sign-out sheet,
--   the counselor's own day — shows school, name, grade and dismissal time
--   together. A 1:1 side table buys a join on all of them. The usual objection
--   is that a SELECT * somewhere starts leaking a child's date of birth or
--   allergies into a response that never had them; that was checked, and there
--   is no SELECT * over children anywhere in server/app.py.
--
-- WHY THERE IS NO status COLUMN
--   The spec asks for status: active/withdrawn. children.active already is
--   that, and it is what every roster, attendance, pickup and parent query
--   filters on. A second column that can disagree with the first puts a
--   withdrawn child on a bus manifest, which is a safety bug rather than a data
--   bug. active stays authoritative; withdrawn_at and withdrawn_reason carry
--   the provenance the spec actually wanted.
--
-- WHY COMPLIANCE IS ROWS AND NOT TEN COLUMNS
--   Ten named columns is the obvious shape for a fixed paper form, and it is
--   the wrong one here. The real values in those cells are a date, or `x`, or
--   `n/a`, or `MISSING`, or `requested updated`, or a medication name — so a
--   typed column degenerates to TEXT holding all of them anyway. The withdrawn
--   sheet carries eight of the items rather than ten, and with columns there is
--   no way to say "this sheet does not track that" as distinct from "blank".
--   And "who still owes paperwork" becomes one WHERE over rows instead of a
--   ten-term OR across columns. The item domain is CHECK-constrained, so a typo
--   is a constraint violation rather than a new de-facto column.
--
-- WHY school_aliases.school_id IS NULLABLE
--   A NULL school_id records a token that was seen and deliberately left
--   unmapped. Three of the ten values in the roster's School column are not
--   schools, and without somewhere to record that, every future upload asks
--   about them again.
--
-- TENANCY
--   All seven new tables are registered in TENANT_TABLES (server/tenancy.py),
--   so init_db() adds organization_id, its default, FK, index and the
--   org_isolation policy on the next boot. Do not add those columns here — the
--   tenancy layer owns them and would fight this file over the details.
--   rooms.name and school_aliases.alias_norm are declared UNIQUE below and are
--   listed in PER_ORG_UNIQUES, which rewrites each into UNIQUE
--   (organization_id, …): two JCCs must both be allowed a room called "Gym".
--
-- WHY THIS IS SAFE
--   Every statement is IF NOT EXISTS or wrapped against duplicate_object, and
--   init_db() applies the same DDL on boot, so an environment that deploys
--   before this file is applied converges anyway. The CHECK constraints all
--   admit NULL, and every existing row is NULL in every new column, so their
--   validating scans pass without a rewrite. children and registrations are a
--   few hundred rows per tenant; the scan is not worth deferring with
--   NOT VALID.
--
-- ORDERING
--   No dependency on any earlier phase. Apply before the importer ships, or it
--   has nowhere to write.
--
-- DEPLOYMENT
--   1. Apply this file.
--   2. Deploy the code (init_db() re-applies the same DDL, then the tenancy
--      layer adds organization_id and the RLS policies to the seven tables).
--   3. Confirm the sanity check at the bottom returns 7 rows, all true.
--   4. Turn `daily_ops` on for the JCCSN organization only.
--
-- ROLLBACK
--   sql/30_rollback_daily_ops_foundation.sql. Read its banner first — it drops
--   every date of birth, allergy and contact this feature stores.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. children — what the roster carries and the app had nowhere to put.
-- -----------------------------------------------------------------------------
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS first_name       TEXT;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS last_name        TEXT;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS grade_label      TEXT;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS grade_num        SMALLINT;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS dob              DATE;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS sex              TEXT;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS allergies        TEXT;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS bus_rider        BOOLEAN;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS notes            TEXT;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS arrival_mode     TEXT;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS roster_flag      TEXT;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS withdrawn_at     TIMESTAMP;
ALTER TABLE public.children ADD COLUMN IF NOT EXISTS withdrawn_reason TEXT;

-- grade_label keeps the roster's own spelling ('K', '0', '3'); grade_num is
-- what range rules compare against, with K and 0 both landing on 0. Storing
-- both makes that collapse reversible if it turns out K and 0 mean different
-- things to this JCC.
DO $$ BEGIN
    ALTER TABLE public.children ADD CONSTRAINT children_sex_check
        CHECK (sex IS NULL OR sex IN ('M', 'F'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 'dropoff' is a parent dropping the child at the JCC; 'bus' is the JCC bus
-- collecting them from school. The roster writes this into the School column
-- as a "- Drop Off" suffix, which the importer splits off.
DO $$ BEGIN
    ALTER TABLE public.children ADD CONSTRAINT children_arrival_mode_check
        CHECK (arrival_mode IS NULL OR arrival_mode IN ('bus', 'dropoff'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 2. registrations — the dismissal time. See the banner.
-- -----------------------------------------------------------------------------
ALTER TABLE public.registrations ADD COLUMN IF NOT EXISTS dismissal_time SMALLINT;

DO $$ BEGIN
    ALTER TABLE public.registrations ADD CONSTRAINT registrations_dismissal_time_check
        CHECK (dismissal_time IS NULL OR dismissal_time BETWEEN 3 AND 6);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 3. school_aliases — one school, several spellings.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.school_aliases (
    id           SERIAL PRIMARY KEY,
    alias        TEXT NOT NULL,
    alias_norm   TEXT NOT NULL UNIQUE,
    school_id    INTEGER REFERENCES public.schools(id) ON DELETE CASCADE,
    arrival_mode TEXT,
    source       TEXT NOT NULL DEFAULT 'import',
    created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
    ALTER TABLE public.school_aliases ADD CONSTRAINT school_aliases_arrival_mode_check
        CHECK (arrival_mode IS NULL OR arrival_mode IN ('bus', 'dropoff'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.school_aliases ADD CONSTRAINT school_aliases_source_check
        CHECK (source IN ('import', 'manual'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- -----------------------------------------------------------------------------
-- 4. child_contacts — the two the roster lists.
--
--    children.parent_id is untouched and still means what it always meant: the
--    account whose parent portal shows this child. It points at contact 1.
--    user_id here is the seam for the day contact 2 gets a portal too — that
--    is a deliberate change to the parent experience, not a side effect of an
--    importer, so nothing fills it for priority 2 yet.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.child_contacts (
    id         SERIAL PRIMARY KEY,
    child_id   INTEGER NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
    priority   SMALLINT NOT NULL,
    name       TEXT NOT NULL,
    phone      TEXT,
    email      TEXT,
    user_id    INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (child_id, priority)
);

DO $$ BEGIN
    ALTER TABLE public.child_contacts ADD CONSTRAINT child_contacts_priority_check
        CHECK (priority IN (1, 2));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_child_contacts_child_id
    ON public.child_contacts (child_id);
CREATE INDEX IF NOT EXISTS idx_child_contacts_email
    ON public.child_contacts (lower(email));

-- -----------------------------------------------------------------------------
-- 5. child_compliance — the paperwork checklist, one row per item.
--
--    raw_value always holds the cell verbatim. status is the reading of it, and
--    recorded_on is set only when the cell held a date. Absent means the cell
--    was blank: no row is written, because "not filled in" and "we do not know"
--    are the same thing on a paper form and neither is 'missing', which is a
--    word the staff writes deliberately.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.child_compliance (
    id          SERIAL PRIMARY KEY,
    child_id    INTEGER NOT NULL REFERENCES public.children(id) ON DELETE CASCADE,
    item        TEXT NOT NULL,
    status      TEXT NOT NULL,
    recorded_on DATE,
    raw_value   TEXT,
    updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (child_id, item)
);

DO $$ BEGIN
    ALTER TABLE public.child_compliance ADD CONSTRAINT child_compliance_item_check
        CHECK (item IN (
            'registration', 'registration_fee', 'membership', 'pickup_form',
            'first_aid', 'medication', 'photo', 'physical', 'immunization',
            'complete', 'bday_card'
        ));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.child_compliance ADD CONSTRAINT child_compliance_status_check
        CHECK (status IN ('done', 'pending', 'waived', 'na', 'missing', 'other'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_child_compliance_child_id
    ON public.child_compliance (child_id);

-- -----------------------------------------------------------------------------
-- 6. rooms — the care rooms children wait in.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.rooms (
    id            SERIAL PRIMARY KEY,
    name          TEXT NOT NULL UNIQUE,
    capacity_hint INTEGER,
    sort_order    INTEGER NOT NULL DEFAULT 100,
    active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- -----------------------------------------------------------------------------
-- 7. care_assignment_rules — which grades wait in which room, per block.
--
--    The spec is explicit that this is admin-configured rather than a fixed
--    algorithm: the split moves with the headcount. A NULL day_of_week is the
--    every-weekday rule. Overlaps are legal and resolved in the application by
--    ordering day-specific before every-day, then the narrower grade range,
--    then priority — so a Wednesday exception can sit on top of the standard
--    week without anyone having to delete the standard week.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.care_assignment_rules (
    id          SERIAL PRIMARY KEY,
    day_of_week TEXT,
    time_block  TEXT NOT NULL,
    grade_min   SMALLINT NOT NULL,
    grade_max   SMALLINT NOT NULL,
    room_id     INTEGER NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    priority    SMALLINT NOT NULL DEFAULT 100,
    created_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

DO $$ BEGIN
    ALTER TABLE public.care_assignment_rules ADD CONSTRAINT care_rules_day_check
        CHECK (day_of_week IS NULL OR day_of_week IN
               ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.care_assignment_rules ADD CONSTRAINT care_rules_block_check
        CHECK (time_block IN ('3-4', '4-5', '5-6'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    ALTER TABLE public.care_assignment_rules ADD CONSTRAINT care_rules_grade_order_check
        CHECK (grade_min <= grade_max);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_care_rules_room_id
    ON public.care_assignment_rules (room_id);
CREATE INDEX IF NOT EXISTS idx_care_rules_block
    ON public.care_assignment_rules (time_block);

-- -----------------------------------------------------------------------------
-- 8. roster_import_batches / roster_import_rows — the staged import.
--
--    An upload parses into rows here and writes nothing to children until an
--    admin confirms. That is what makes the preview trustworthy: the numbers
--    they approved and the numbers that commit come from the same parse, not
--    from parsing the same file twice and hoping.
--
--    roster_import_rows.parsed is a second copy of children's dates of birth,
--    allergies and phone numbers, with a different lifetime from children. The
--    importer prunes old batches on every upload; that retention is a privacy
--    control, not housekeeping.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.roster_import_batches (
    id           SERIAL PRIMARY KEY,
    filename     TEXT NOT NULL,
    file_sha256  TEXT,
    uploaded_by  INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    uploaded_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    status       TEXT NOT NULL DEFAULT 'preview',
    committed_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    committed_at TIMESTAMP,
    totals       JSONB NOT NULL DEFAULT '{}'::jsonb,
    error        TEXT
);

DO $$ BEGIN
    ALTER TABLE public.roster_import_batches ADD CONSTRAINT roster_import_batches_status_check
        CHECK (status IN ('preview', 'committed', 'discarded', 'failed'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS public.roster_import_rows (
    id             SERIAL PRIMARY KEY,
    batch_id       INTEGER NOT NULL REFERENCES public.roster_import_batches(id) ON DELETE CASCADE,
    source_sheet   TEXT NOT NULL,
    source_row     INTEGER NOT NULL,
    action         TEXT NOT NULL,
    match_child_id INTEGER REFERENCES public.children(id) ON DELETE SET NULL,
    child_name     TEXT,
    school_raw     TEXT,
    grade_raw      TEXT,
    parsed         JSONB NOT NULL DEFAULT '{}'::jsonb,
    changes        JSONB NOT NULL DEFAULT '[]'::jsonb,
    notices        JSONB NOT NULL DEFAULT '[]'::jsonb,
    applied_at     TIMESTAMP,
    UNIQUE (batch_id, source_sheet, source_row)
);

-- source_row is the child's row number in Heather's spreadsheet. It is carried
-- all the way to the review screen so that "row 143 has no school" is something
-- she can act on in the file she already has open.
DO $$ BEGIN
    ALTER TABLE public.roster_import_rows ADD CONSTRAINT roster_import_rows_action_check
        CHECK (action IN ('create', 'update', 'unchanged', 'withdraw', 'skip', 'blocked'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_roster_import_rows_batch
    ON public.roster_import_rows (batch_id, action);

-- -----------------------------------------------------------------------------
-- 9. Deny the PostgREST roles, matching 01_enable_rls_deny_all.sql. The
--    per-organization policies are installed by init_db() via
--    tenancy._ensure_policies(); this is the outer lock, not that one.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
    t text;
    tables text[] := ARRAY[
        'school_aliases', 'child_contacts', 'child_compliance', 'rooms',
        'care_assignment_rules', 'roster_import_batches', 'roster_import_rows'
    ];
BEGIN
    FOREACH t IN ARRAY tables LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS deny_all_anon ON public.%I', t);
        EXECUTE format(
            'CREATE POLICY deny_all_anon ON public.%I '
            'AS RESTRICTIVE FOR ALL TO anon, authenticated '
            'USING (false) WITH CHECK (false)',
            t
        );
        EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated', t);
    END LOOP;
END$$;

-- -----------------------------------------------------------------------------
-- 10. Sanity check — should return 7 rows, all with rls_enabled = true.
-- -----------------------------------------------------------------------------
SELECT tablename, rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
      'school_aliases', 'child_contacts', 'child_compliance', 'rooms',
      'care_assignment_rules', 'roster_import_batches', 'roster_import_rows'
  )
ORDER BY tablename;

COMMIT;
