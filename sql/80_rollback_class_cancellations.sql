-- =============================================================================
-- kikar-afterschool — Phase 79 ROLLBACK: Drop one-day class cancellations
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code has been reverted:
--
--     • Remove 'class_cancellations' from TENANT_TABLES (server/tenancy.py)
--       and its CREATE TABLE from init_db() (server/database.py), or the next
--       boot puts it back.
--     • Revert cancelled_class_ids() and the cancellation routes in
--       server/app.py, and the cancel/restore UI in
--       web/src/routes/admin/DailyBoard.tsx.
--
-- WHAT YOU LOSE
--   Every cancellation, past and upcoming. Upcoming ones matter: after the
--   rollback those classes run again on their dates. Check first:
--
--     SELECT cs.name, cc.cancel_date, cc.reason
--       FROM public.class_cancellations cc
--       JOIN public.class_sessions cs ON cs.id = cc.class_session_id
--      WHERE cc.cancel_date >= CURRENT_DATE
--      ORDER BY cc.cancel_date;
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.class_cancellations;

COMMIT;
