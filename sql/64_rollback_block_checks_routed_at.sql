-- =============================================================================
-- kikar-afterschool — Phase 63 ROLLBACK: Drop the "routed onward" timestamp
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code that reads and writes this column has
--   been reverted:
--
--     • Remove the `ALTER TABLE ... ADD COLUMN IF NOT EXISTS routed_at` from
--       init_db() in server/database.py, or the next boot puts the column
--       straight back.
--     • Revert server/app.py's block-checks GET/POST to the version that
--       does not read or write `routed_at`.
--     • Revert web/src/routes/counselor/MyDay.tsx to the version with no
--       second control.
--
-- WHAT YOU LOSE
--   For every date, whether a confirmed child was ever also marked as walked
--   to their next class or CARE room, and when. `created_at` — the original
--   "this child was in front of me" confirmation — is untouched; this only
--   ever added a second, later timestamp beside it.
--
--   Export first if the JCC needs the trail for a compliance question:
--
--     COPY (SELECT organization_id, check_date, child_id, class_session_id,
--                  room_id, time_block, created_at, routed_at
--             FROM block_checks
--            WHERE routed_at IS NOT NULL
--            ORDER BY organization_id, check_date, routed_at)
--       TO '/tmp/block_checks_routed_backup.csv' WITH CSV HEADER;
--
-- WHAT SURVIVES
--   block_checks itself, and every other column on it — this migration only
--   ever added routed_at.
-- =============================================================================

BEGIN;

ALTER TABLE public.block_checks
    DROP COLUMN IF EXISTS routed_at;

-- -----------------------------------------------------------------------------
-- Sanity check — should return 0 rows.
-- -----------------------------------------------------------------------------
SELECT column_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'block_checks'
  AND column_name = 'routed_at';

COMMIT;
