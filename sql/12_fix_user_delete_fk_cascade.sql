-- =============================================================================
-- jclub-app — Phase 12: Allow user deletion by setting audit FKs to ON DELETE SET NULL
-- =============================================================================
--
-- WHAT THIS DOES
--   Six columns reference users(id) with the implicit ON DELETE NO ACTION /
--   RESTRICT default. They record "who marked this absence", "who submitted
--   this attendance roll", etc. — pure audit metadata, never used for
--   business logic (only the two attendance read endpoints JOIN through
--   submitted_by, and those are being relaxed to LEFT JOIN in the same PR).
--
--   Today those FKs block DELETE FROM users for any counselor that has ever
--   taken attendance or marked an absence — i.e. all of them — so the admin
--   "Delete counselor" button always fails. This migration relaxes the FKs to
--   ON DELETE SET NULL so deleting a user nulls the audit reference and the
--   historical row is preserved (reports render "(deleted user)" instead of
--   the counselor's name).
--
--     • absences.marked_by              (also DROP NOT NULL)
--     • recurring_absences.marked_by    (also DROP NOT NULL)
--     • absence_exceptions.marked_by    (also DROP NOT NULL)
--     • attendance_records.submitted_by (also DROP NOT NULL)
--     • parent_notifications.sent_by    (also DROP NOT NULL)
--     • calendar_events.created_by      (already nullable, only FK changes)
--
--   This extends the existing project convention already used by
--   pickup_claim_audit.user_id and admin_messages.sender_id ("preserve the
--   audit row, drop the link to the deleted user").
--
-- HOW
--   For each column: drop NOT NULL (where applicable), look up the existing
--   FK constraint via pg_constraint (not by guessed name) and drop it, then
--   add a new FK with ON DELETE SET NULL and the canonical name
--   <table>_<column>_fkey.
--
--   The Flask app's init_db() also applies this idempotently at startup —
--   this file is for environments where DDL is reviewed and applied manually.
--
-- DEPLOYMENT
--   1. Apply this file in Supabase SQL Editor (BEGIN/COMMIT wrapper makes it
--      all-or-nothing).
--   2. Deploy the Flask + frontend changes. init_db() will see the FK already
--      has confdeltype='n' and no-op the re-apply.
--   3. Verify: from the admin portal, delete a counselor that has historical
--      attendance / absence records — should succeed with 200. Attendance
--      reports for those past days should still list the rows with
--      submitted_by = "(deleted user)".
--
-- ROLLBACK
--   See 13_rollback_user_delete_fk_cascade.sql. Note: a strict rollback to
--   NOT NULL requires manually reassigning any rows where the column became
--   NULL after this migration was in effect (no other way — the original
--   user_id is gone).
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Helper-free single-statement DO block per table. Each block:
--   1. Drops NOT NULL on the audit column (skipped for calendar_events).
--   2. Finds the FK constraint by introspection (pg_constraint), regardless of
--      its auto-generated name, and drops it.
--   3. Adds a new FK with the canonical name <table>_<column>_fkey and
--      ON DELETE SET NULL. Wrapped in NOT EXISTS check so the block is
--      idempotent — re-runs after the first successful apply are no-ops.
-- -----------------------------------------------------------------------------

-- absences.marked_by
DO $$
DECLARE c_name text;
BEGIN
    ALTER TABLE public.absences ALTER COLUMN marked_by DROP NOT NULL;
    SELECT conname INTO c_name FROM pg_constraint
        WHERE conrelid = 'public.absences'::regclass
          AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid='public.absences'::regclass AND attname='marked_by')]
          AND (confdeltype <> 'n' OR conname <> 'absences_marked_by_fkey');
    IF c_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.absences DROP CONSTRAINT %I', c_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='public.absences'::regclass
                     AND conname='absences_marked_by_fkey') THEN
        ALTER TABLE public.absences
            ADD CONSTRAINT absences_marked_by_fkey
            FOREIGN KEY (marked_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- recurring_absences.marked_by
DO $$
DECLARE c_name text;
BEGIN
    ALTER TABLE public.recurring_absences ALTER COLUMN marked_by DROP NOT NULL;
    SELECT conname INTO c_name FROM pg_constraint
        WHERE conrelid = 'public.recurring_absences'::regclass
          AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid='public.recurring_absences'::regclass AND attname='marked_by')]
          AND (confdeltype <> 'n' OR conname <> 'recurring_absences_marked_by_fkey');
    IF c_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.recurring_absences DROP CONSTRAINT %I', c_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='public.recurring_absences'::regclass
                     AND conname='recurring_absences_marked_by_fkey') THEN
        ALTER TABLE public.recurring_absences
            ADD CONSTRAINT recurring_absences_marked_by_fkey
            FOREIGN KEY (marked_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- absence_exceptions.marked_by
DO $$
DECLARE c_name text;
BEGIN
    ALTER TABLE public.absence_exceptions ALTER COLUMN marked_by DROP NOT NULL;
    SELECT conname INTO c_name FROM pg_constraint
        WHERE conrelid = 'public.absence_exceptions'::regclass
          AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid='public.absence_exceptions'::regclass AND attname='marked_by')]
          AND (confdeltype <> 'n' OR conname <> 'absence_exceptions_marked_by_fkey');
    IF c_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.absence_exceptions DROP CONSTRAINT %I', c_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='public.absence_exceptions'::regclass
                     AND conname='absence_exceptions_marked_by_fkey') THEN
        ALTER TABLE public.absence_exceptions
            ADD CONSTRAINT absence_exceptions_marked_by_fkey
            FOREIGN KEY (marked_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- attendance_records.submitted_by
DO $$
DECLARE c_name text;
BEGIN
    ALTER TABLE public.attendance_records ALTER COLUMN submitted_by DROP NOT NULL;
    SELECT conname INTO c_name FROM pg_constraint
        WHERE conrelid = 'public.attendance_records'::regclass
          AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid='public.attendance_records'::regclass AND attname='submitted_by')]
          AND (confdeltype <> 'n' OR conname <> 'attendance_records_submitted_by_fkey');
    IF c_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.attendance_records DROP CONSTRAINT %I', c_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='public.attendance_records'::regclass
                     AND conname='attendance_records_submitted_by_fkey') THEN
        ALTER TABLE public.attendance_records
            ADD CONSTRAINT attendance_records_submitted_by_fkey
            FOREIGN KEY (submitted_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- parent_notifications.sent_by
DO $$
DECLARE c_name text;
BEGIN
    ALTER TABLE public.parent_notifications ALTER COLUMN sent_by DROP NOT NULL;
    SELECT conname INTO c_name FROM pg_constraint
        WHERE conrelid = 'public.parent_notifications'::regclass
          AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid='public.parent_notifications'::regclass AND attname='sent_by')]
          AND (confdeltype <> 'n' OR conname <> 'parent_notifications_sent_by_fkey');
    IF c_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.parent_notifications DROP CONSTRAINT %I', c_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='public.parent_notifications'::regclass
                     AND conname='parent_notifications_sent_by_fkey') THEN
        ALTER TABLE public.parent_notifications
            ADD CONSTRAINT parent_notifications_sent_by_fkey
            FOREIGN KEY (sent_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- calendar_events.created_by (already nullable; only the FK rule changes)
DO $$
DECLARE c_name text;
BEGIN
    SELECT conname INTO c_name FROM pg_constraint
        WHERE conrelid = 'public.calendar_events'::regclass
          AND contype = 'f'
          AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                              WHERE attrelid='public.calendar_events'::regclass AND attname='created_by')]
          AND (confdeltype <> 'n' OR conname <> 'calendar_events_created_by_fkey');
    IF c_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE public.calendar_events DROP CONSTRAINT %I', c_name);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                   WHERE conrelid='public.calendar_events'::regclass
                     AND conname='calendar_events_created_by_fkey') THEN
        ALTER TABLE public.calendar_events
            ADD CONSTRAINT calendar_events_created_by_fkey
            FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE SET NULL;
    END IF;
END $$;

-- -----------------------------------------------------------------------------
-- Sanity check — every row should show confdeltype = 'n' (SET NULL).
-- -----------------------------------------------------------------------------
SELECT conrelid::regclass AS table_name, conname, confdeltype
FROM pg_constraint
WHERE conname IN (
    'absences_marked_by_fkey',
    'recurring_absences_marked_by_fkey',
    'absence_exceptions_marked_by_fkey',
    'attendance_records_submitted_by_fkey',
    'parent_notifications_sent_by_fkey',
    'calendar_events_created_by_fkey'
)
ORDER BY conrelid::regclass::text;

COMMIT;
