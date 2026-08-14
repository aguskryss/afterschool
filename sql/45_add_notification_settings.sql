-- =============================================================================
-- kikar-afterschool — Phase 45: a JCC decides what its parents hear about
-- =============================================================================
--
-- WHAT THIS DOES
--   Two tables:
--
--     notification_settings   one row per organization: which parent-facing
--                             events actually send a push, and what time the
--                             daily "is your child coming?" question goes out.
--
--     scheduled_runs          the claim that makes a daily job run once rather
--                             than once per worker.
--
--   No organization has a settings row until someone opens the screen, and that
--   is the normal state: every key falls back to its catalogue default in
--   server/tenancy.py, so existing organizations behave exactly as they do now.
--
-- WHY A TABLE AND NOT COLUMNS ON `organizations`
--   Because RLS will not allow the latter. The org_self policy on
--   `organizations` carries WITH CHECK (is_superadmin), so an organization
--   cannot write its own row at all — which is deliberate and load-bearing: it
--   is what makes the email sender in sql/41 unforgeable in the database rather
--   than only in a route.
--
--   These settings belong to the JCC's own administrator, not to Kikar. A
--   setting the JCC owns therefore needs a table the JCC may write, which means
--   one registered in TENANT_TABLES and covered by org_isolation.
--
--   Modules and notifications look alike and are not: a module is what a JCC
--   BOUGHT and only a superadmin may change; a notification is how a JCC RUNS
--   its afternoon. Same organization, different authority.
--
-- WHY THE TIME IS TEXT AND NOT `time`
--   It is a wall-clock time in the organization's timezone, not an instant.
--   `time` would invite comparison against server time, which is UTC, and
--   1:00 PM in Reno is not 1:00 PM in Miami. Text keeps the conversion where it
--   belongs: in the scheduler, which reads organizations.timezone alongside it.
--   The CHECK enforces the shape.
--
-- WHY scheduled_runs IS NOT A TENANT TABLE
--   It carries organization_id, but it is written by a background thread whose
--   whole job is deciding WHICH organizations are due — which means reading
--   across all of them. RLS would hide exactly the rows that loop exists to
--   find. It holds no personal data: an organization id, a job name, a date.
--
--   Its primary key is the claim. Two workers racing to fire the same job on
--   the same day cannot both win; the second INSERT conflicts and does nothing.
--   Same trick as bulk_invite_jobs.
--
-- organization_id IS NOT DECLARED ON notification_settings
--   The tenancy layer adds it, with its default, FK, index and org_isolation
--   policy. Per §6 of CLAUDE.md, tables in TENANT_TABLES must not carry it by
--   hand. That is also why the unique index below is a separate statement: the
--   column it indexes does not exist until that layer has run.
--
-- MIRRORED IN init_db()
--   server/tenancy.py runs the same statements idempotently on every boot.
--
-- ROLLBACK
--   sql/46_rollback_notification_settings.sql
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS notification_settings (
    id                  SERIAL PRIMARY KEY,
    prefs               JSONB NOT NULL DEFAULT '{}'::jsonb,
    attendance_check_at TEXT,
    updated_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT notification_settings_time_check CHECK (
        attendance_check_at IS NULL
        OR attendance_check_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
    )
);

-- One row per organization: the organization is the whole key, which is what
-- lets the API upsert in a single statement instead of read-then-branch. Two
-- admins saving at the same moment would otherwise each insert a row, and the
-- settings would depend on which one the next SELECT happened to find.
--
-- Run this AFTER the application has booted once against this database, or by
-- hand after adding organization_id — the tenancy layer owns that column.
CREATE UNIQUE INDEX IF NOT EXISTS notification_settings_org_unique
    ON notification_settings (organization_id);

CREATE TABLE IF NOT EXISTS scheduled_runs (
    organization_id INTEGER NOT NULL
        REFERENCES organizations(id) ON DELETE CASCADE,
    job             TEXT NOT NULL,
    run_date        DATE NOT NULL,
    ran_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
    PRIMARY KEY (organization_id, job, run_date)
);

COMMIT;
