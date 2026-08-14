-- =============================================================================
-- kikar-afterschool — Rollback of Phase 45
-- =============================================================================
--
-- WHAT THIS RESTORES
--   Every parent-facing notification fires for every organization again, the
--   way it did before there was anything to switch off, and the scheduled
--   attendance check stops existing.
--
-- WHAT IT COSTS
--   Every JCC's choices. An organization that deliberately turned off "child
--   was picked up" starts sending it again the moment this runs, and nobody is
--   told. If the intent is to stop using the feature but keep the settings,
--   do NOT run this — reverting the application is enough, because code that
--   never reads these columns behaves identically to a database without them.
--
--   Read the values out first if there is any chance of wanting them back:
--
--     SELECT slug, notification_prefs, attendance_check_at
--       FROM organizations
--      WHERE notification_prefs <> '{}'::jsonb
--         OR attendance_check_at IS NOT NULL;
--
-- REVERTING THE CODE IS REQUIRED FIRST
--   server/app.py selects both columns by name and server/tenancy.py re-adds
--   them on the next boot.
--
-- scheduled_runs GOES TOO
--   It only records that a job fired on a day. Dropping it loses that history;
--   it does not undo anything that was sent. If the application is still
--   running when this executes, a scheduler mid-tick would error rather than
--   double-send — the claim it needs would not exist.
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS scheduled_runs;

DROP TABLE IF EXISTS notification_settings;

COMMIT;
