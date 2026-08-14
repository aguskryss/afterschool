-- =============================================================================
-- Supabase first-time setup for Kikar Afterschool
-- =============================================================================
--
-- Run this ONCE in the Supabase SQL Editor, on a fresh project, BEFORE the
-- first deploy. It creates the low-privilege role the application connects as.
--
-- Why a separate role at all: tenant isolation is enforced by row level
-- security, and RLS is skipped entirely for any role with BYPASSRLS — which
-- Supabase's default `postgres` role has. Connecting as `postgres` would leave
-- the policies configured but doing nothing, and one JCC could read another's
-- children. The app says so at boot either way; this is what makes it say the
-- good thing.
--
-- STEP 1 — choose a password and replace it below. Use something long and
--          random. Do not reuse the project's database password.

CREATE ROLE kikar_app LOGIN PASSWORD 'REPLACE_WITH_A_LONG_RANDOM_PASSWORD';

-- STEP 2 — grant it what the application needs and nothing more. It reads and
-- writes rows; it never creates tables. Schema changes run as the owner via
-- ADMIN_DATABASE_URL, which is why init_db() needs a second connection string.

GRANT USAGE ON SCHEMA public TO kikar_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO kikar_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kikar_app;

-- Tables created by a later deploy must be reachable too, or the app breaks
-- the first time a migration adds one.
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO kikar_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO kikar_app;

-- STEP 3 — confirm the role is actually subject to RLS. This must print false.
-- If it prints true, the isolation is inert and the app will warn at boot.

SELECT rolname, rolbypassrls
  FROM pg_roles
 WHERE rolname = 'kikar_app';

-- STEP 4 — smoke test only. If this errors, LISTEN/NOTIFY is definitely
-- unavailable. If it succeeds, that is NOT proof it works: the SQL Editor
-- runs statements over a connection you don't hold, so a notification has
-- nowhere to be observed arriving.
--
-- The conclusive test is scripts/check_connection.py, run against the exact
-- connection string you are about to put in Render. It opens the connection,
-- listens, notifies, and waits for delivery.

LISTEN kikar_setup_probe;
SELECT pg_notify('kikar_setup_probe', 'ok');
UNLISTEN kikar_setup_probe;

-- Then, from the repo:
--
--   DATABASE_URL='postgresql://kikar_app:...@...:5432/postgres' \
--       python3 scripts/check_connection.py
--
-- Getting this wrong does not fail loudly: pickups simply never appear on
-- anyone's screen.
