-- =============================================================================
-- kikar-afterschool — Phase 71: Emergency headcount
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds the two tables behind the admin's "Emergency check" screen: an
--   evacuation or a drill, run as a roll call over every child in the building
--   at the moment it starts.
--
--   emergency_checks          — one row per check. `ended_at IS NULL` is the
--                               open one; there is at most one per JCC.
--   emergency_check_children  — one row per child on that check's list, and
--                               whether (and by whom) they were accounted for.
--
-- WHY THE LIST IS A SNAPSHOT
--   "In the building" is attendance_records.on_bus = 1 with no checked_out_at
--   for the day — the same definition the live headcount uses. That set keeps
--   moving while the check runs: a parent can still collect a child at the
--   gate. If the list were recomputed on every read, a child released mid-
--   evacuation would simply vanish from the roll call, and "missing" and
--   "went home" would look the same. So the children in the building when the
--   check starts are written down (in_snapshot = TRUE), and the screen shows a
--   release that happens afterwards next to the name rather than dropping it.
--
--   A child checked in AFTER the check started is not in the snapshot. The
--   screen lists them from the live set and they get a row (in_snapshot =
--   FALSE) the moment someone accounts for them.
--
-- WHY accounted_by IS ON DELETE SET NULL
--   The record of a drill outlives the staff account that ran it.
--
-- WHAT MUST HAPPEN IN THE SAME DEPLOY
--   • Both tables go in TENANT_TABLES (server/tenancy.py), which adds
--     organization_id, its FK, its index and the org_isolation policy. Do NOT
--     add those columns here.
--   • init_db() (server/database.py) mirrors both CREATE TABLEs, and creates
--     the partial unique index that allows one open check per organization.
--     That index names organization_id, which only exists after the tenancy
--     pass, so it lives in init_db() and not in this file. Applying this file
--     alone is still safe: the next boot converges.
--   • server/app.py: the /api/admin/emergency-check routes, mapped to the
--     check_in_out module in MODULE_ROUTES.
-- =============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.emergency_checks (
    id SERIAL PRIMARY KEY,
    check_date DATE NOT NULL,
    note TEXT,
    started_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    ended_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.emergency_check_children (
    id SERIAL PRIMARY KEY,
    check_id INTEGER NOT NULL
        REFERENCES public.emergency_checks(id) ON DELETE CASCADE,
    child_id INTEGER NOT NULL
        REFERENCES public.children(id) ON DELETE CASCADE,
    in_snapshot BOOLEAN NOT NULL DEFAULT TRUE,
    accounted_at TIMESTAMP,
    accounted_by INTEGER REFERENCES public.users(id) ON DELETE SET NULL,
    UNIQUE (check_id, child_id)
);

CREATE INDEX IF NOT EXISTS idx_emergency_checks_started
    ON public.emergency_checks (started_at);

-- -----------------------------------------------------------------------------
-- Sanity check — should return 2 rows.
-- -----------------------------------------------------------------------------
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('emergency_checks', 'emergency_check_children');

COMMIT;
