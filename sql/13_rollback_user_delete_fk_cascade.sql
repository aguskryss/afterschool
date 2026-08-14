-- =============================================================================
-- jclub-app — Phase 13: Rollback of Phase 12 (user-delete FK SET NULL)
-- =============================================================================
--
-- WHAT THIS DOES
--   Reverts the six FKs touched by 12_fix_user_delete_fk_cascade.sql back to
--   their original ON DELETE NO ACTION (RESTRICT) behavior, and re-applies
--   NOT NULL to the five columns that had it.
--
-- !!! IMPORTANT — DATA REPAIR STEP REQUIRED BEFORE RUNNING !!!
--   If Phase 12 was active in production for any length of time, deleting a
--   counselor or parent will have NULLed audit columns on historical rows.
--   PostgreSQL will refuse SET NOT NULL while NULL values exist. You MUST
--   first reassign or delete those rows.
--
--   Recommended pattern (replace <fallback_admin_id> with an existing admin
--   user_id you want to attribute orphaned audit rows to):
--
--     UPDATE absences              SET marked_by    = <fallback_admin_id> WHERE marked_by    IS NULL;
--     UPDATE recurring_absences    SET marked_by    = <fallback_admin_id> WHERE marked_by    IS NULL;
--     UPDATE absence_exceptions    SET marked_by    = <fallback_admin_id> WHERE marked_by    IS NULL;
--     UPDATE attendance_records    SET submitted_by = <fallback_admin_id> WHERE submitted_by IS NULL;
--     UPDATE parent_notifications  SET sent_by      = <fallback_admin_id> WHERE sent_by      IS NULL;
--     -- calendar_events.created_by was already nullable pre-12; leave as-is.
--
--   The original user_id is unrecoverable — pick a sentinel admin and document
--   the reassignment.
--
-- DEPLOYMENT
--   1. (If needed) Run the UPDATE statements above against your DB.
--   2. Apply this file in Supabase SQL Editor.
--   3. Re-deploy the previous Flask version (the rollback does NOT remove the
--      Python try/except or the LEFT JOIN tweaks — those are forward-safe
--      against either FK rule).
-- =============================================================================

BEGIN;

-- absences.marked_by — back to NO ACTION + NOT NULL
ALTER TABLE public.absences DROP CONSTRAINT IF EXISTS absences_marked_by_fkey;
ALTER TABLE public.absences
    ADD CONSTRAINT absences_marked_by_fkey
    FOREIGN KEY (marked_by) REFERENCES public.users(id);
ALTER TABLE public.absences ALTER COLUMN marked_by SET NOT NULL;

-- recurring_absences.marked_by
ALTER TABLE public.recurring_absences DROP CONSTRAINT IF EXISTS recurring_absences_marked_by_fkey;
ALTER TABLE public.recurring_absences
    ADD CONSTRAINT recurring_absences_marked_by_fkey
    FOREIGN KEY (marked_by) REFERENCES public.users(id);
ALTER TABLE public.recurring_absences ALTER COLUMN marked_by SET NOT NULL;

-- absence_exceptions.marked_by
ALTER TABLE public.absence_exceptions DROP CONSTRAINT IF EXISTS absence_exceptions_marked_by_fkey;
ALTER TABLE public.absence_exceptions
    ADD CONSTRAINT absence_exceptions_marked_by_fkey
    FOREIGN KEY (marked_by) REFERENCES public.users(id);
ALTER TABLE public.absence_exceptions ALTER COLUMN marked_by SET NOT NULL;

-- attendance_records.submitted_by
ALTER TABLE public.attendance_records DROP CONSTRAINT IF EXISTS attendance_records_submitted_by_fkey;
ALTER TABLE public.attendance_records
    ADD CONSTRAINT attendance_records_submitted_by_fkey
    FOREIGN KEY (submitted_by) REFERENCES public.users(id);
ALTER TABLE public.attendance_records ALTER COLUMN submitted_by SET NOT NULL;

-- parent_notifications.sent_by
ALTER TABLE public.parent_notifications DROP CONSTRAINT IF EXISTS parent_notifications_sent_by_fkey;
ALTER TABLE public.parent_notifications
    ADD CONSTRAINT parent_notifications_sent_by_fkey
    FOREIGN KEY (sent_by) REFERENCES public.users(id);
ALTER TABLE public.parent_notifications ALTER COLUMN sent_by SET NOT NULL;

-- calendar_events.created_by — stays nullable, only restore NO ACTION
ALTER TABLE public.calendar_events DROP CONSTRAINT IF EXISTS calendar_events_created_by_fkey;
ALTER TABLE public.calendar_events
    ADD CONSTRAINT calendar_events_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES public.users(id);

-- Sanity check — confdeltype should be 'a' (NO ACTION) for all six.
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
