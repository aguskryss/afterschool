-- =============================================================================
-- kikar-afterschool — Phase 61: index child_contacts.user_id
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds a partial index on child_contacts(user_id).
--
-- WHY NOW
--   child_contacts.user_id has existed since sql/29 as "the seam for the day
--   contact 2 gets a portal too" (server/database.py's comment on the table)
--   but was never read. Phase 61's application code is what starts reading
--   it — every parent-facing request now checks whether the caller is either
--   children.parent_id OR a linked child_contacts.user_id — so it goes from
--   an unindexed, unused column to one looked up on every such request.
--
-- WHY PARTIAL
--   Most rows have user_id NULL (an unlinked Contact #2, or any Contact #1
--   row — contact 1 never uses this column, only children.parent_id does).
--   Indexing only the linked rows keeps it small and skips maintaining index
--   entries for values nothing ever searches for.
--
-- MIRRORED IN init_db()
--   Per §6 of CLAUDE.md, server/database.py creates the same index
--   idempotently on every boot.
--
-- ROLLBACK
--   sql/62_rollback_child_contacts_user_index.sql
-- =============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS idx_child_contacts_user
    ON child_contacts(user_id) WHERE user_id IS NOT NULL;

COMMIT;
