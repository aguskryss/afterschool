-- =============================================================================
-- kikar-afterschool — Rollback of Phase 59
-- =============================================================================
--
-- WHAT THIS RESTORES
--   Drops `users.email_notifications`.
--
-- REVERTING THE CODE IS REQUIRED FIRST
--   server/app.py reads this column in notify_parent() and
--   _run_broadcast_pushes, and writes it from
--   GET/PATCH /api/parent/email-notifications. server/database.py re-adds
--   it on the next boot. Revert the application before running this file,
--   or the next notification send fails with an undefined-column error.
-- =============================================================================

BEGIN;

ALTER TABLE users DROP COLUMN IF EXISTS email_notifications;

COMMIT;
