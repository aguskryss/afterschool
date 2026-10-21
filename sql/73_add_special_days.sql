-- =============================================================================
-- kikar-afterschool — Phase 73: Special-day rosters
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds the two tables behind the admin's "Special days" screen: a roster for
--   one date that replaces the weekly enrollment on that date. For early
--   dismissals and vacation days, when only some children come, only some of
--   those ride the bus (the rest are dropped off by a parent), and a child who
--   is not normally enrolled that weekday may come just for that day.
--
--   special_days          — one row per date that has its own list.
--   special_day_children  — one row per child coming that day: whether they
--                           ride the bus, and their pickup hour (3-6, the same
--                           range as registrations.dismissal_time).
--
-- HOW IT IS READ
--   When a date has a special_days row, its children ARE that day's roster:
--   the bus list, the headcount, the afternoon board, the daily-ops plan and
--   the morning attendance ask all read it instead of `registrations`. A child
--   left off the list is "not scheduled", not "absent" — nobody gets asked
--   whether they are coming. Deleting the row puts the date back on the
--   weekly enrollment.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • Both tables go in TENANT_TABLES (server/tenancy.py), which adds
--     organization_id, its FK, its index and the org_isolation policy. Do NOT
--     add those columns here.
--   • init_db() (server/database.py) mirrors both CREATE TABLEs and creates
--     the unique index on (organization_id, day_date). That index names
--     organization_id, which only exists after the tenancy pass, so it lives
--     in init_db() and not in this file. Applying this file alone is still
--     safe: the next boot converges.
--   • server/app.py: the /api/admin/special-days routes (core) and
--     registrations_for_date(), which every reader above goes through.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.special_days (
    id SERIAL PRIMARY KEY,
    day_date DATE NOT NULL,
    note TEXT,
    created_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.special_day_children (
    id SERIAL PRIMARY KEY,
    special_day_id INTEGER NOT NULL
        REFERENCES public.special_days(id) ON DELETE CASCADE,
    child_id INTEGER NOT NULL
        REFERENCES public.children(id) ON DELETE CASCADE,
    on_bus BOOLEAN NOT NULL DEFAULT TRUE,
    dismissal_time SMALLINT
        CHECK (dismissal_time IS NULL OR dismissal_time BETWEEN 3 AND 6),
    UNIQUE (special_day_id, child_id)
);

-- -----------------------------------------------------------------------------
-- Sanity check — should return 2 rows.
-- -----------------------------------------------------------------------------
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('special_days', 'special_day_children');

COMMIT;
