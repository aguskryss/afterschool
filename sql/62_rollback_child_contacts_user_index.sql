-- =============================================================================
-- kikar-afterschool — Rollback of Phase 61
-- =============================================================================
--
-- WHAT THIS RESTORES
--   Drops idx_child_contacts_user. Safe on its own — nothing but query
--   planning depends on this index existing; no data or constraint changes.
-- =============================================================================

BEGIN;

DROP INDEX IF EXISTS idx_child_contacts_user;

COMMIT;
