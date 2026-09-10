-- =============================================================================
-- kikar-afterschool — Phase 63: A second confirmation — routed onward
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds `block_checks.routed_at`, a second nullable timestamp beside
--   `created_at` on the same row. `created_at` already answers "is this child
--   in front of me, in this block" (sql/47). This answers a different
--   question a class counselor asks near the end of the hour: "has this
--   specific child actually been walked to where they go next."
--
-- WHY A SECOND COLUMN ON THE SAME ROW, NOT A SECOND TABLE
--   A child cannot be routed onward before they were confirmed present in the
--   block they are being routed FROM — routing is something that happens to a
--   row that already exists. Two columns on one row keep that ordering true by
--   construction: the write path only ever sets `routed_at` with an UPDATE,
--   never an INSERT, so a row with `routed_at` set and no `created_at` cannot
--   exist. A separate table would need its own foreign key back to this one
--   to say the same thing, and could still be written out of order.
--
-- WHY THIS DOES NOT COVER "handed to a parent"
--   That is a release with a signature (spec R6), tracked on
--   `attendance_records`/`absences` and surfaced by the parent-pickup group on
--   My day — a different screen's job, and already gray there once it
--   happens. `routed_at` only ever means "walked to another class or a CARE
--   room," which is the one case those tables cannot answer, because from
--   their point of view the child never left the building.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • The matching `ALTER TABLE ... ADD COLUMN IF NOT EXISTS routed_at` goes
--     in init_db() (server/database.py), right after block_checks' own
--     CREATE TABLE, so a database that never ran this file converges.
--   • server/app.py's block-checks GET/POST read and write it.
--   • web/src/routes/counselor/MyDay.tsx draws the second control.
-- =============================================================================

BEGIN;

ALTER TABLE public.block_checks
    ADD COLUMN IF NOT EXISTS routed_at TIMESTAMP;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 1 row naming the new column.
-- -----------------------------------------------------------------------------
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'block_checks'
  AND column_name = 'routed_at';

COMMIT;
