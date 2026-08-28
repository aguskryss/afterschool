-- =============================================================================
-- kikar-afterschool — Phase 55: track when a user last logged in
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds one nullable column to `users`:
--
--     last_login_at   TIMESTAMPTZ, stamped by the app on every fully
--                      successful sign-in (after 2FA, if the account has it)
--
--   NULL for every existing row and for anyone who has never completed a
--   login since this shipped — that is a real state ("never signed in"), not
--   a gap to backfill.
--
-- WHY NOT REUSE password_set_at
--   password_set_at answers "did they ever finish onboarding" and is set once,
--   forever. This answers "when did they last actually use the app," which is
--   what the admin Parents and Counselors screens now show — an admin asking
--   whether an invited parent has actually opened the app since needs the
--   most recent visit, not the first one.
--
-- WHEN IT IS STAMPED
--   In /api/auth/login, only once the sign-in is fully accepted — after the
--   password check AND, if the account has 2FA, after the TOTP code is
--   verified. A request that stops at `requires_2fa: true` is not a login
--   yet and must not count as one.
--
-- MIRRORED IN init_db()
--   Per §6 of CLAUDE.md, server/database.py runs the same statement
--   idempotently on every boot, so a deploy that predates this file
--   converges anyway.
--
-- ROLLBACK
--   sql/56_rollback_last_login_at.sql
-- =============================================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

COMMIT;
