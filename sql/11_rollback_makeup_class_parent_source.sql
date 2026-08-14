-- =============================================================================
-- jclub-app — Phase 10 rollback: Parent-submitted make-up classes
-- =============================================================================
--
-- WHAT THIS DOES
--   Reverses 10_add_makeup_class_parent_source.sql. Drops the four columns
--   added to activity_roster and the partial index that targets parent_makeup
--   rows.
--
--   Run this AFTER reverting the application code (the backend reads/writes
--   these columns; dropping them while the app is live will 500 the make-up
--   endpoints).
--
-- WHAT IT DOES NOT TOUCH
--   • Existing activity_roster rows with source='parent_makeup' will remain
--     in the table after rollback. They become indistinguishable from regular
--     'manual' entries except for the source value, which is harmless.
--   • The admin Manual Entries flow keeps working since DROP COLUMN is the
--     only schema change.
--
-- DEPLOYMENT
--   1. Revert the Flask + frontend changes for parent make-up classes.
--   2. Apply this file in Supabase SQL Editor.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS public.idx_activity_roster_parent_makeup;

ALTER TABLE public.activity_roster
    DROP COLUMN IF EXISTS admin_seen_at;

ALTER TABLE public.activity_roster
    DROP COLUMN IF EXISTS counselor_locked;

ALTER TABLE public.activity_roster
    DROP COLUMN IF EXISTS parent_will_pickup;

ALTER TABLE public.activity_roster
    DROP COLUMN IF EXISTS requested_by_parent_id;

COMMIT;
