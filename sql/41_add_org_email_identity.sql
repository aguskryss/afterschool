-- =============================================================================
-- kikar-afterschool — Phase 41: each organization sends from its own address
-- =============================================================================
--
-- WHAT THIS DOES
--   Adds three nullable columns to `organizations` so mail leaving the platform
--   can carry the JCC's identity instead of Kikar's:
--
--     email_from_local  the local part of the sender — `jccns`, not an address
--     email_from_name   the display name; NULL means "use the organization name"
--     email_reply_to    where a parent's reply should land, at the JCC
--
--   All three are NULL for every existing row, and NULL is a working state: the
--   sender falls back to the slug, the display name to `name`, and Reply-To is
--   simply not set. Nothing has to be filled in for this to be correct.
--
-- WHY THE LOCAL PART AND NOT AN ADDRESS
--   This is the part worth reading. An `email_from` column holding a whole
--   address would let whoever writes it send as any domain on earth — including
--   another JCC's, or Kikar's own. Validation could forbid that, but validation
--   is a thing you can forget to run on the next endpoint that writes the
--   column.
--
--   Storing only the local part makes the domain unforgeable by construction.
--   The application appends EMAIL_SENDER_DOMAIN (default `kikarlabs.com`) and
--   there is no string a caller can put in this column that escapes it: an `@`
--   is rejected on the way in, and even if one got through it would produce
--   `a@b@kikarlabs.com`, which is not a delivery to `a@b`. The column cannot
--   express the dangerous value.
--
--   The CHECK constraint below enforces the same rule in the database, so the
--   guarantee does not depend on the API being the only writer.
--
-- WHY ONE DOMAIN AND NOT ONE PER JCC
--   Resend verifies domains, not addresses: once `kikarlabs.com` is verified
--   every `*@kikarlabs.com` sends with no further setup. A domain per JCC would
--   mean SPF/DKIM records in DNS that the JCC controls and we do not, a support
--   burden per customer, and — the part that actually costs — sending
--   reputation split across several cold domains instead of accumulating on one
--   warm one. `jccns@kikarlabs.com` with the JCC's name as the display name and
--   their own address in Reply-To reads, in a parent's inbox, as the JCC.
--
-- WHY REPLY-TO IS STORED AND NOT DERIVED
--   "The JCC's admin" is not a single row: an organization can have five
--   administrators, and picking one by id would silently publish a particular
--   person's address to every parent and change when that person leaves. An
--   explicit column is a decision someone made rather than a query result that
--   drifts. The console offers the organization's admins as suggestions so
--   setting it is still one click.
--
-- WHO CAN WRITE THESE
--   Superadmin only, through PATCH /api/superadmin/organizations/<id>. This is
--   deliberate and is not an ordinary permissions choice: the sender address is
--   the one field where a tenant writing its own value affects what other
--   tenants' recipients see. An organization admin who could set their own
--   local part could take `noreply`, or another JCC's slug, and send mail that
--   is — as far as SPF, DKIM and the receiving inbox are concerned — genuinely
--   from us.
--
-- MIRRORED IN init_db()
--   Per §6 of CLAUDE.md, server/tenancy.py:ensure_tenancy_schema() runs the
--   same statements idempotently on every boot, so a deploy that predates this
--   file converges anyway.
--
-- ROLLBACK
--   sql/42_rollback_org_email_identity.sql. It drops the three columns, which
--   loses whatever was configured; the code reverts to one platform-wide
--   sender and keeps working.
-- =============================================================================

BEGIN;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_from_local TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_from_name  TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_reply_to   TEXT;

-- The domain guarantee, in the database rather than only in Python.
--
-- Lowercase letters, digits, dot, underscore and hyphen; must start and end
-- alphanumeric; 64 characters is the RFC 5321 limit for a local part. No `@`,
-- no whitespace, no quoting — so no value here can carry a domain of its own.
-- NULL stays legal and means "fall back to the slug".
DO $$
BEGIN
    ALTER TABLE organizations
        ADD CONSTRAINT organizations_email_from_local_check
        CHECK (
            email_from_local IS NULL
            OR email_from_local ~ '^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$'
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Reply-To is the JCC's own address on the JCC's own domain, so it cannot be
-- constrained to ours. It is still checked for the shape of an address, which
-- is what keeps a stray name or phone number out of a header.
DO $$
BEGIN
    ALTER TABLE organizations
        ADD CONSTRAINT organizations_email_reply_to_check
        CHECK (
            email_reply_to IS NULL
            OR email_reply_to ~ '^[^@[:space:],<>]+@[^@[:space:],<>]+\.[^@[:space:],<>]+$'
        );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

COMMIT;
