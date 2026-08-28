-- =============================================================================
-- kikar-afterschool — Rollback of Phase 55
-- =============================================================================
--
-- WHAT THIS RESTORES
--   Drops `users.last_login_at`. The admin Parents and Counselors screens stop
--   showing a "Last login" column the moment the application code selecting
--   it is reverted — nothing here depends on the app being rolled back first,
--   since a missing column just isn't selected.
--
-- REVERTING THE CODE IS REQUIRED FIRST IN THE OTHER DIRECTION
--   server/app.py writes this column on every login and selects it in the
--   admin parents/counselors listings, and server/database.py re-adds it on
--   the next boot. Revert the application before running this file, or the
--   next login attempt fails with an undefined-column error.
-- =============================================================================

BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS last_login_at;

COMMIT;
