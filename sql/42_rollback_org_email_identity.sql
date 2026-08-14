-- =============================================================================
-- kikar-afterschool — Rollback of Phase 41
-- =============================================================================
--
-- WHAT THIS RESTORES
--   One platform-wide sender. Every organization goes back to sending from
--   EMAIL_FROM (or its EMAIL_USER / `noreply@kikarlabs.com` fallbacks) with
--   EMAIL_FROM_NAME as the display name and no Reply-To header.
--
-- WHAT IT COSTS
--   Whatever was configured. Dropping the columns discards every per-JCC local
--   part, display-name override and reply address; there is no other copy. If
--   the intent is to stop using per-organization senders but keep the settings
--   for later, do NOT run this — set the columns back to NULL instead, which
--   produces the same behaviour and is reversible:
--
--     UPDATE organizations
--        SET email_from_local = NULL,
--            email_from_name  = NULL,
--            email_reply_to   = NULL;
--
--   Read the values out first if you may want them back:
--
--     SELECT slug, email_from_local, email_from_name, email_reply_to
--       FROM organizations
--      WHERE email_from_local IS NOT NULL
--         OR email_from_name  IS NOT NULL
--         OR email_reply_to   IS NOT NULL;
--
-- REVERTING THE CODE IS REQUIRED
--   Unlike most of the pairs in this directory, dropping these columns while
--   the new code is deployed is not survivable: server/app.py selects the three
--   columns by name when it resolves an organization's email identity, and
--   server/tenancy.py re-adds them on the next boot. Revert the application
--   first, then run this file.
-- =============================================================================

BEGIN;

ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_email_from_local_check;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS organizations_email_reply_to_check;

ALTER TABLE organizations DROP COLUMN IF EXISTS email_from_local;
ALTER TABLE organizations DROP COLUMN IF EXISTS email_from_name;
ALTER TABLE organizations DROP COLUMN IF EXISTS email_reply_to;

COMMIT;
