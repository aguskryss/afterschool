-- =============================================================================
-- kikar-afterschool — Phase 77 ROLLBACK: Drop voided pickup releases
-- =============================================================================
--
-- WHEN TO USE
--   Run only after the application code has been reverted:
--
--     • Remove 'pickup_release_voids' from TENANT_TABLES (server/tenancy.py)
--       and its CREATE TABLE from init_db() (server/database.py), or the next
--       boot puts it back.
--     • Revert POST /api/admin/pickup-releases/<id>/void and the `voided`
--       list in server/app.py, and the void UI in
--       web/src/routes/admin/PickupLog.tsx.
--
-- WHAT YOU LOSE
--   The record of every voided release: who was wrongly recorded as taking a
--   child, their signature, and who voided it and why. The releases that
--   stand are untouched. Export it first if anyone may ask later:
--
--     SELECT release_date, child_id, person_name, counselor_name, released_at,
--            voided_by_name, voided_at, void_reason
--       FROM public.pickup_release_voids ORDER BY voided_at;
-- =============================================================================

BEGIN;

DROP TABLE IF EXISTS public.pickup_release_voids;

COMMIT;
