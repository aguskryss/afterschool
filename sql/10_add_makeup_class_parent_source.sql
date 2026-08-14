-- =============================================================================
-- jclub-app — Phase 10: Parent-submitted make-up classes
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds four columns to the existing activity_roster table so parents can
--   submit one-off make-up classes from their portal. The make-up rows
--   piggy-back on the existing specific_date column (already used by admin
--   manual make-up entries) so counselors keep seeing them on their daily
--   roster with no read-side changes.
--
--     • requested_by_parent_id — user_id of the parent who created the entry
--                                (NULL for excel/manual entries).
--     • parent_will_pickup     — TRUE when the parent will pick up the child
--                                themselves (no Pick Up roster row is created).
--     • counselor_locked       — TRUE if an admin manually overrode the
--                                auto-resolved counselor; cascade re-syncs skip
--                                rows where this is set.
--     • admin_seen_at          — timestamp when an admin first viewed the
--                                request, used to drive the "NEW" badge in the
--                                admin Make-up Requests sub-tab.
--
--   The Flask app's init_db() also adds these idempotently — this file is for
--   environments where DDL is reviewed and applied manually.
--
-- HOW MAKE-UP COUNSELORS GET RESOLVED
--   On parent submit, the backend looks up the recurring activity_roster row
--   matching (activity_id, day_of_week, action, action_time) — i.e. "who's the
--   counselor for Visual Arts on Tuesdays at 4:00 PM?" — and copies that
--   assigned_counselor_id onto the new make-up row. When the admin reassigns
--   the recurring row, a cascade UPDATE re-syncs all future make-up rows for
--   the same slot whose counselor_locked is FALSE.
--
-- WHY THIS IS SAFE
--   • Pure additive change: only ADD COLUMN IF NOT EXISTS, no destructive DDL.
--   • All defaults are NULL or FALSE, so existing rows are unaffected.
--   • Source value 'parent_makeup' is a new string but the source column is a
--     plain TEXT (no CHECK constraint), so no schema change is needed there.
--   • Re-runnable: every statement is IF NOT EXISTS-guarded.
--
-- DEPLOYMENT
--   1. Apply this file in Supabase SQL Editor (BEGIN/COMMIT wrapper makes it
--      all-or-nothing).
--   2. Deploy the Flask + frontend changes. init_db() will see the columns
--      already exist and no-op them.
--   3. Verify: log in as parent → side menu → "Make-up Classes" → submit one →
--      check it appears in admin Activity Rosters → "Make-up Requests" sub-tab.
--
-- ROLLBACK
--   See 11_rollback_makeup_class_parent_source.sql. Drops the four columns in
--   dependency-safe order. Safe to run after reverting the application code.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Add the four new columns to activity_roster.
-- -----------------------------------------------------------------------------
ALTER TABLE public.activity_roster
    ADD COLUMN IF NOT EXISTS requested_by_parent_id INTEGER REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.activity_roster
    ADD COLUMN IF NOT EXISTS parent_will_pickup BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.activity_roster
    ADD COLUMN IF NOT EXISTS counselor_locked BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE public.activity_roster
    ADD COLUMN IF NOT EXISTS admin_seen_at TIMESTAMP;

-- -----------------------------------------------------------------------------
-- 2. Partial index for the admin "Make-up Requests" view: only future,
--    parent-submitted rows. Keeps the list query fast even when the roster
--    grows large.
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_activity_roster_parent_makeup
    ON public.activity_roster(specific_date, admin_seen_at)
    WHERE source = 'parent_makeup';

-- -----------------------------------------------------------------------------
-- 3. Sanity check — should return 4 rows, one per new column.
-- -----------------------------------------------------------------------------
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'activity_roster'
  AND column_name IN ('requested_by_parent_id','parent_will_pickup',
                      'counselor_locked','admin_seen_at')
ORDER BY column_name;

COMMIT;
