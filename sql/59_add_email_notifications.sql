-- =============================================================================
-- kikar-afterschool — Phase 59: email as a second notification channel
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds one column to `users`:
--
--     email_notifications   BOOLEAN NOT NULL DEFAULT FALSE
--
--   FALSE for every existing row and for anyone who signs up after this
--   ships, until they turn it on themselves in Account. Opt-in on purpose —
--   push already requires an explicit browser permission grant, and this is
--   the same shape of consent for a second channel, not a default nobody
--   asked for.
--
-- WHAT IT IS FOR
--   Push is not reliable for every parent (the device never granted
--   permission, the subscription went stale, or they just never enabled
--   it). This is a parent-level preference, layered ON TOP OF the
--   organization-level switches in `notification_settings` — an admin can
--   still turn `office_message` or `new_photos` off for the whole JCC, and
--   this column only matters for the kinds that are on. See
--   server/app.py's notify_parent() and _run_broadcast_pushes for where it
--   is read.
--
-- WHY ONE COLUMN, NOT A JSONB LIKE notification_settings.prefs
--   notification_settings is per-organization and per-kind, because an
--   admin genuinely wants "announcements yes, pickup pings no". A parent
--   choosing email is a much smaller decision — "also send me what I
--   already get by push" — and a per-kind grid for a channel most parents
--   will just flip on once is a control nobody asked for. One boolean is
--   the whole feature.
--
-- MIRRORED IN init_db()
--   Per §6 of CLAUDE.md, server/database.py runs the same statement
--   idempotently on every boot, so a deploy that predates this file
--   converges anyway.
--
-- ROLLBACK
--   sql/60_rollback_email_notifications.sql
-- =============================================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
