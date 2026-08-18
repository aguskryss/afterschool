"""Multi-tenancy: organizations, per-organization modules, and the schema
changes that make every tenant-scoped table carry its owner.

Kikar owns the platform; each JCC is one organization. The model is exactly
two levels — there are no sub-organizations, so an organization never has a
parent and `organization_id` is always the whole answer to "whose row is this".

Superadmins are the one exception: they sit above every organization and carry
`organization_id IS NULL`.
"""

import os
import re

try:
    from server import brand_storage
except ImportError:  # running from inside server/
    import brand_storage

# ─── Outgoing mail identity ───────────────────────────────────────────────
#
# Lives here, next to the organizations schema, because the regex below and the
# CHECK constraint in ensure_tenancy_schema() enforce the same rule and have to
# agree. Splitting them across modules is how they drift.
#
# THE DOMAIN IS NOT STORED PER ORGANIZATION, AND THAT IS THE POINT.
# Resend verifies domains, not addresses, so with kikarlabs.com verified every
# *@kikarlabs.com sends for free. Organizations store only the local part; the
# domain is appended here. No value a caller can write escapes it, which makes
# "a JCC cannot send as another JCC's domain, or as ours" a property of the
# data model rather than of remembering to validate.

EMAIL_SENDER_DOMAIN = os.environ.get('EMAIL_SENDER_DOMAIN', 'kikarlabs.com')

# RFC 5321 caps a local part at 64 characters. Mirrors
# organizations_email_from_local_check.
EMAIL_LOCAL_PART_RE = re.compile(r'^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$')

# Deliberately loose — enough to keep a name or a phone number out of a
# Reply-To header, not an attempt to implement RFC 5322. Mirrors
# organizations_email_reply_to_check.
EMAIL_ADDRESS_RE = re.compile(r'^[^@\s,<>]+@[^@\s,<>]+\.[^@\s,<>]+$')


def org_logo_url(row) -> str | None:
    """The logo an organization should be shown with, or None for the wordmark.

    Two sources with an explicit order, resolved here so no caller has to
    remember it:

      logo_path  an image uploaded to our own bucket — wins
      logo_url   a link to an image on the JCC's own site — the fallback

    Lives beside org_from_email() for the same reason: both turn a row of the
    organizations table into the thing the rest of the app should actually use,
    and both are needed by app.py and superadmin.py, which cannot import each
    other.

    Takes the row rather than two arguments so a caller that forgets to SELECT
    logo_path gets a KeyError here instead of silently falling back to the old
    column and showing a stale logo.
    """
    uploaded = brand_storage.public_url(row['logo_path'])
    if uploaded:
        return uploaded
    return (row['logo_url'] or '').strip() or None


def org_from_email(email_from_local: str | None, slug: str | None) -> str | None:
    """The address an organization sends from, or None if it has no handle.

    The slug is the fallback local part, so a JCC sends as `jccns@…` with
    nothing configured and `email_from_local` is purely an override.
    """
    local = (email_from_local or slug or '').strip().lower()
    if not local or not EMAIL_LOCAL_PART_RE.match(local):
        return None
    return f"{local}@{EMAIL_SENDER_DOMAIN}"


# ─── What a parent gets notified about ────────────────────────────────────
#
# Separate from MODULES, and the distinction is worth keeping straight:
#
#   a module is what a JCC BOUGHT     — superadmin decides, it is billing
#   a notification is how a JCC RUNS  — its own admin decides, it is taste
#
# A JCC that pays for the pickup queue may still not want a push every time a
# counselor claims a child; that is not a smaller product, it is a different
# afternoon.
#
# They live in `notification_settings`, NOT as columns on `organizations`, and
# that is forced by RLS rather than taste: the org_self policy carries
# WITH CHECK (is_superadmin), so an organization cannot write its own row at
# all. That is what makes the email sender unforgeable in the database. A
# setting the JCC owns therefore needs a table the JCC may write.
#
# Defaults are here rather than in the database for the same reason the module
# defaults are: adding one should not need a migration, and an organization
# that has never heard of a key inherits the default below.
#
# Every key must be gated at exactly one place in app.py — see notify_parent().
# A new event that forgets the check is a push a JCC switched off and still
# received.

PARENT_NOTIFICATIONS: dict[str, tuple[str, str, bool]] = {
    # key                  label                     description                                          default
    'attendance_check': (
        'Attendance check',
        'Asks whether their child is coming. Sent by a counselor, or on a '
        'schedule if one is set below.',
        True,
    ),
    'pickup_claimed': (
        'Someone is bringing your child',
        'When a counselor claims a pickup and is walking the child out.',
        True,
    ),
    'pickup_released': (
        'Child was picked up',
        'When a child is signed out to an authorized person.',
        True,
    ),
    'office_message': (
        'Message from the office',
        'A reply in the parent conversation.',
        True,
    ),
    'new_photos': (
        'New photos',
        'When a photo their child appears in is posted.',
        True,
    ),
    'broadcast': (
        'Announcements',
        'The program-wide messages an administrator sends.',
        True,
    ),
}


def default_notifications() -> dict:
    return {key: default for key, (_l, _d, default) in PARENT_NOTIFICATIONS.items()}


def notification_on(prefs, key: str) -> bool:
    """Whether an organization sends this notification to parents.

    Unknown keys are ON, which is the opposite of module_enabled's rule and is
    deliberate. An unknown module is something unpaid for and must fail closed.
    An unknown notification key is a new event this organization has never been
    asked about, and silently withholding it would look like a bug — the JCC
    would see the thing happen and no notification, with nothing switched off
    on screen to explain it.
    """
    if key in PARENT_NOTIFICATIONS:
        fallback = PARENT_NOTIFICATIONS[key][2]
    else:
        fallback = True
    return bool((prefs or {}).get(key, fallback))


# ─── Modules ──────────────────────────────────────────────────────────────
#
# Attendance and rosters are the product; they are not toggleable. Everything
# below can be turned off per organization by a superadmin, because not every
# JCC runs activities, sends broadcasts, or wants parents booking make-ups.
#
# Defaults live here rather than in the database so adding a module doesn't
# need a migration — an organization that has never heard of a key simply
# inherits the default below.

MODULES: dict[str, tuple[str, bool]] = {
    # key                    label                                default
    'pickups': ('Live pickup queue', True),
    'absences': ('Parent-reported absences', True),
    'recurring_absences': ('Recurring absences', True),
    'makeup_classes': ('Make-up classes', False),
    'activities': ('Activity rosters and drop-offs', False),
    'messages': ('Broadcast messages to parents', True),
    'calendar': ('Program calendar', True),
    'time_off': ('Counselor day-off requests', True),
    'push': ('Push notifications', True),
    'two_factor': ('Two-factor authentication', False),

    # Sold separately, so they default off — an organization gets these only
    # once a superadmin turns them on. The two pickup modules are independent
    # on purpose: a JCC can run the live queue, the authorized-person release,
    # both, or neither.
    'secure_pickup': ('Authorized pickup list', False),
    'check_in_out': ('Check-in / check-out times', False),
    'photos': ('Daily photos', False),
    'parent_messaging': ('Parent-to-admin messaging', False),
    'staff_messaging': ('Staff-to-admin messaging', False),
    'late_arrivals': ('Parent-reported late arrivals', False),

    # The JCC that runs its afternoon off a hand-built 33-sheet workbook: its
    # own roster importer, rooms, and the daily views derived from them. Off
    # for everyone else, who keep the roster upload they already have.
    'daily_ops': ('Daily operations', False),
}


def default_modules() -> dict[str, bool]:
    return {key: default for key, (_label, default) in MODULES.items()}


def module_enabled(org_modules: dict | None, key: str) -> bool:
    """Whether `key` is on for an organization.

    Unknown keys are off: a typo should fail closed, not silently enable
    something. Keys the organization has no opinion on fall back to the
    default declared above.
    """
    if key not in MODULES:
        return False
    if not org_modules:
        return MODULES[key][1]
    value = org_modules.get(key)
    return MODULES[key][1] if value is None else bool(value)


# ─── Which routes belong to which module ──────────────────────────────────
#
# Modules are what a JCC buys, so the refusal has to happen on the server —
# hiding a screen in the client is a courtesy, not a control. app.py enforces
# this in a before_request hook.
#
# One table rather than a decorator on each of the ~70 routes, so the whole
# billing boundary reads at once and tests/test_module_access.py can assert
# that no /api route is silently uncovered.
#
# Longest prefix wins, so a specific route can sit under a broader one.

MODULE_ROUTES: tuple[tuple[str, str], ...] = (
    ('/api/parent/pickup', 'pickups'),
    ('/api/counselor/pickup-alerts', 'pickups'),
    ('/api/pickups/', 'pickups'),

    ('/api/parent/absences', 'absences'),
    ('/api/admin/absences', 'absences'),
    ('/api/admin/export/absences', 'absences'),

    ('/api/parent/recurring-absences', 'recurring_absences'),
    ('/api/parent/absence-exceptions', 'recurring_absences'),

    ('/api/parent/makeup-classes', 'makeup_classes'),
    ('/api/admin/makeup-requests', 'makeup_classes'),

    ('/api/admin/activities', 'activities'),
    ('/api/admin/activity-roster', 'activities'),
    ('/api/admin/activity-schedules', 'activities'),
    ('/api/admin/counselor-roster', 'activities'),
    ('/api/counselor/activities', 'activities'),

    ('/api/admin/messages', 'messages'),
    ('/api/parent/messages', 'messages'),

    ('/api/admin/calendar', 'calendar'),
    ('/api/parent/calendar', 'calendar'),
    ('/api/counselor/calendar', 'calendar'),

    ('/api/counselor/time-off', 'time_off'),
    ('/api/admin/time-off', 'time_off'),

    ('/api/push/', 'push'),
    ('/api/auth/2fa/', 'two_factor'),

    # Attendance itself is core; the times and the live headcount are not.
    ('/api/attendance/', 'check_in_out'),
    # The afternoon board generalises that headcount — same question, per
    # school and with the children still outstanding named — so it sits behind
    # the same module rather than giving away what that one sells.
    ('/api/admin/operations', 'check_in_out'),

    # The authorized-person release. Longest-prefix resolution keeps
    # /api/counselor/pickup/ separate from /api/counselor/pickup-alerts above,
    # which belongs to the other pickup module.
    ('/api/parent/authorized-pickups', 'secure_pickup'),
    ('/api/counselor/authorized-pickups', 'secure_pickup'),
    ('/api/counselor/pickup/', 'secure_pickup'),
    # The admin's record of the same releases, and its export.
    ('/api/admin/pickup-releases', 'secure_pickup'),
    ('/api/admin/export/pickup-releases', 'secure_pickup'),

    # Conversations, distinct from the `messages` broadcast above.
    ('/api/parent/conversation', 'parent_messaging'),
    ('/api/admin/conversations', 'parent_messaging'),

    # The staff side of the same idea: a counselor can only write to the
    # admin, never to a parent. Its own module — an organization can buy one
    # conversation channel without the other.
    ('/api/counselor/conversation', 'staff_messaging'),
    ('/api/admin/staff-conversations', 'staff_messaging'),

    ('/api/counselor/photos', 'photos'),
    ('/api/parent/photos', 'photos'),

    # The JCCSN roster importer and the school names it resolves against.
    # /api/admin/upload-roster is deliberately NOT here: it is the positional
    # importer every other JCC uses, and it stays core.
    ('/api/admin/roster-import', 'daily_ops'),
    ('/api/admin/school-aliases', 'daily_ops'),
    # The care rooms children wait in, which every derived afternoon view points
    # at. Deliberately not core: no other JCC has the concept, and the screens
    # that read this are the ones daily_ops sells.
    ('/api/admin/rooms', 'daily_ops'),
    # The class catalogue. The importer writes the rows; this is where the hours
    # that make them routable get filled in.
    ('/api/admin/class-sessions', 'daily_ops'),
    # Which grade waits in which room, per block — the parenthesised text in the
    # Care sheet's headers.
    ('/api/admin/care-rules', 'daily_ops'),
    # The counselor lists in those same headers. Deliberately NOT named
    # /api/admin/counselor-assignments: that prefix is declared core in
    # tests/test_module_access.py, so a route under it would be free for every
    # JCC with nothing failing to say so.
    ('/api/admin/staff-assignments', 'daily_ops'),
    # The counselor's own afternoon, which replaces the highlighted printout.
    # /api/counselor/roster next door is core — it is the school-gate list every
    # JCC uses — so this had to be a new path rather than a shape of that one.
    ('/api/counselor/my-day', 'daily_ops'),
    # Confirming a child inside one of those blocks. Same module as the screen
    # that draws the control: a JCC without daily_ops has no classes and no care
    # rooms, so there is no block to be confirmed in.
    ('/api/counselor/block-checks', 'daily_ops'),
    # The same afternoon unfiltered: the two attendance sheets (§3.5, §3.6).
    ('/api/admin/daily-board', 'daily_ops'),
)


def module_for_path(path: str) -> str | None:
    """The module a request path belongs to, or None if the route is core.

    Attendance, rosters, auth and the admin's people screens are the product
    itself: they have no module and are never refused.
    """
    best: tuple[str, str] | None = None
    for prefix, key in MODULE_ROUTES:
        if path.startswith(prefix) and (best is None or len(prefix) > len(best[0])):
            best = (prefix, key)
    return best[1] if best else None


# ─── Tenant-scoped tables ─────────────────────────────────────────────────
#
# Every table below gets its own organization_id column rather than reaching
# the owner through joins. Denormalising costs one integer per row and buys
# RLS policies that a reviewer can check by eye, which is the right trade in
# the boundary that separates one JCC's children from another's.

TENANT_TABLES = (
    'notification_settings',
    'users',
    'schools',
    'grades',
    'counselor_schools',
    'counselor_school_changes',
    'children',
    'child_notes',
    'registrations',
    'absences',
    'recurring_absences',
    'absence_exceptions',
    'invitations',
    'attendance_records',
    'parent_notifications',
    'calendar_events',
    'password_reset_tokens',
    'push_subscriptions',
    'user_totp',
    'pickup_notifications',
    'pickup_claim_audit',
    'authorized_pickup_people',
    'pickup_releases',
    'activities',
    'activity_schedules',
    'activity_roster',
    'activity_completions',
    'activity_roster_overrides',
    'admin_messages',
    'admin_message_schools',
    'parent_messages',
    'parent_threads',
    'thread_messages',
    'staff_threads',
    'staff_thread_messages',
    'photos',
    'photo_tags',
    'counselor_time_off',
    'bulk_invite_jobs',
    # Daily operations (sql/29_add_daily_ops_foundation.sql). The staging pair
    # belongs here as much as the rest: a roster_import_rows row holds a copy of
    # a child's date of birth and allergies, so it needs the same isolation the
    # children row does.
    'school_aliases',
    'child_contacts',
    'child_compliance',
    'rooms',
    'care_assignment_rules',
    'roster_import_batches',
    'roster_import_rows',
    # The class catalog (sql/35_add_class_sessions.sql). class_enrollments is
    # as sensitive as the roster it comes from: a row is "this named child is
    # in this room at this hour on Tuesday", which is exactly what the
    # isolation is for.
    'class_sessions',
    'class_enrollments',
    # Who is in each class and each care room (sql/37). A row names a real
    # counselor and, through the class or room it points at, a group of real
    # children — the same isolation the roster needs.
    'staff_assignments',
    # Who was confirmed in which block, on which date (sql/47). A row names a
    # real child and the room they were standing in at a given hour — the same
    # isolation the roster needs, for the same reason.
    'block_checks',
)

# Deliberately global, not tenant-scoped:
#   app_settings   — VAPID keypair and other infrastructure config
#   login_attempts — rate limiting is keyed by IP; scoping it per organization
#                    would let an attacker reset their budget by guessing at a
#                    different tenant.
GLOBAL_TABLES = ('app_settings', 'login_attempts')

# Uniques that are correct for a single tenant and wrong for many: two JCCs
# must both be allowed a school called "Beth Am".
PER_ORG_UNIQUES = (
    ('schools', 'schools_name_key', ('name',)),
    ('grades', 'grades_name_key', ('name',)),
    ('activities', 'activities_name_key', ('name',)),
    (
        'activity_schedules',
        'activity_schedules_activity_name_pattern_day_of_week_key',
        ('activity_name_pattern', 'day_of_week'),
    ),
    # Two JCCs must both be allowed a room called "Gym", and both be allowed to
    # spell a school "SPS".
    ('rooms', 'rooms_name_key', ('name',)),
    ('school_aliases', 'school_aliases_alias_norm_key', ('alias_norm',)),
    # class_sessions is not in this list. Two JCCs must both be allowed a Monday
    # class called "Chess", so it needs the same per-organization treatment, but
    # its key includes a nullable start_time — one JCC can run "HW Club" twice
    # on a Tuesday — and a NULL in a unique *constraint* is distinct from every
    # other NULL. It is built as a unique index over COALESCE instead, in
    # database.py next to the staff_assignments ones.
    (
        'class_enrollments',
        'class_enrollments_child_id_class_session_id_key',
        ('child_id', 'class_session_id'),
    ),
)


def set_current_organization(cur, organization_id) -> None:
    """Pin the connection to one organization.

    Drives both the column defaults on INSERT and the RLS policies on read.
    `set_config(..., false)` scopes it to the session rather than a
    transaction, because get_db() hands out autocommit connections where a
    transaction-local setting would evaporate before the query runs.

    Pooled connections are reused, so every checkout must set this — and
    clear_current_organization() must run on release, or one request's tenant
    leaks into the next.
    """
    cur.execute(
        "SELECT set_config('app.organization_id', %s, false)",
        ('' if organization_id is None else str(organization_id),),
    )


def clear_current_organization(cur) -> None:
    cur.execute("SELECT set_config('app.organization_id', '', false)")


def ensure_tenancy_schema(cur) -> None:
    """Create the organizations table and make every tenant table carry it.

    Idempotent: safe to run on every boot, like the rest of init_db().
    """
    cur.execute("""
        CREATE TABLE IF NOT EXISTS organizations (
            id SERIAL PRIMARY KEY,
            slug TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL,
            -- Two sources, explicit precedence. logo_path is an uploaded file
            -- in a bucket we own and wins; logo_url is a link to an image on
            -- the JCC's own site and is the fallback. See sql/43.
            logo_url TEXT DEFAULT NULL,
            logo_path TEXT DEFAULT NULL,
            brand_primary TEXT DEFAULT NULL,
            brand_accent TEXT DEFAULT NULL,
            -- Every date calculation in the app ("is the child here today?")
            -- resolves against this, so a JCC outside Eastern time is correct
            -- rather than silently off by a day at the edges.
            timezone TEXT NOT NULL DEFAULT 'America/New_York',
            status TEXT NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'suspended')),
            modules JSONB NOT NULL DEFAULT '{}'::jsonb,
            -- Who this organization's mail comes from. See the block below for
            -- why the sender is stored as a local part and not an address.
            email_from_local TEXT,
            email_from_name TEXT,
            email_reply_to TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # sql/41, mirrored idempotently per §6 of CLAUDE.md — CREATE TABLE IF NOT
    # EXISTS above does nothing on a database that already has the table, so
    # the columns have to be added separately for it to converge.
    #
    # `email_from_local` holds `jccns`, not `jccns@kikarlabs.com`. The domain is
    # appended by the application from EMAIL_SENDER_DOMAIN, which makes it
    # unforgeable: there is no value this column can hold that sends as another
    # domain. That is a stronger guarantee than validating an address column on
    # the way in, because it survives the next endpoint someone adds without
    # remembering the rule. The CHECK keeps it true even for a write that does
    # not go through the API.
    #
    # All three are NULL for existing rows and NULL is a working state: the
    # sender falls back to the slug, the display name to `name`, and no
    # Reply-To header is set.
    # sql/43. An uploaded logo, as an object key in the `brand` bucket rather
    # than a URL: the bucket name and project host stay in configuration, so
    # moving them is not an UPDATE across every row. Falls back to logo_url —
    # a link to an image on the JCC's own site — when NULL.
    cur.execute("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS logo_path TEXT")

    # sql/45. In their OWN table, not as columns on `organizations`, and the
    # reason is the org_self policy below: it has
    # WITH CHECK (is_superadmin), so an organization cannot write its own row.
    # That is deliberate and load-bearing — it is what makes the email sender
    # unforgeable in the database rather than only in a route. These settings
    # belong to the JCC's own administrator, so they need a table the JCC may
    # write, which is any table in TENANT_TABLES.
    #
    # organization_id is NOT declared here: the tenancy layer adds it, with its
    # default, FK, index and org_isolation policy. Per §6 of CLAUDE.md.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS notification_settings (
            id SERIAL PRIMARY KEY,
            prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
            attendance_check_at TEXT,
            updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT notification_settings_time_check CHECK (
                attendance_check_at IS NULL
                OR attendance_check_at ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
            )
        )
    """)
    # The claim that makes a daily job run once instead of once per worker.
    # Outside TENANT_TABLES on purpose: the scheduler reads across every
    # organization to find which are due, and RLS would hide exactly those rows.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS scheduled_runs (
            organization_id INTEGER NOT NULL
                REFERENCES organizations(id) ON DELETE CASCADE,
            job             TEXT NOT NULL,
            run_date        DATE NOT NULL,
            ran_at          TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
            PRIMARY KEY (organization_id, job, run_date)
        )
    """)

    cur.execute("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_from_local TEXT")
    cur.execute("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_from_name TEXT")
    cur.execute("ALTER TABLE organizations ADD COLUMN IF NOT EXISTS email_reply_to TEXT")
    cur.execute("""
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
    """)
    cur.execute(r"""
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
    """)

    # The one record that outlives an organization.
    #
    # Deliberately outside TENANT_TABLES, and deliberately without a foreign key
    # to organizations: either would take this row away along with the row it
    # exists to describe. `deleted_organization_id` is named so that it cannot
    # be mistaken later for the tenant column every other table carries.
    #
    # `photo_paths` is the part that earns its keep. Photographs live in
    # Supabase Storage rather than in Postgres, so deleting an organization
    # cascades away the rows that point at the objects without touching the
    # objects. Keeping the paths here is the only thing that makes them
    # findable afterwards; without it they are unreachable bytes that happen to
    # be photographs of other people's children.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS organization_deletions (
            id SERIAL PRIMARY KEY,
            deleted_organization_id INTEGER NOT NULL,
            slug TEXT NOT NULL,
            name TEXT NOT NULL,
            deleted_by INTEGER,
            deleted_by_email TEXT,
            deleted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            counts JSONB NOT NULL DEFAULT '{}'::jsonb,
            photo_paths JSONB NOT NULL DEFAULT '[]'::jsonb
        )
    """)

    # A single organization to own everything that already exists. On an empty
    # database this is simply the first tenant; locally it adopts the seed data.
    cur.execute("SELECT id FROM organizations ORDER BY id LIMIT 1")
    row = cur.fetchone()
    if row is None:
        cur.execute("""
            INSERT INTO organizations (slug, name)
            VALUES ('kikar', 'Kikar Afterschool')
            RETURNING id
        """)
        row = cur.fetchone()
    default_org_id = row['id'] if isinstance(row, dict) else row[0]

    for table in TENANT_TABLES:
        cur.execute(
            f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS organization_id INTEGER"
        )
        # Adopt any pre-tenancy rows before the column is made mandatory.
        # Superadmins are the exception: their null organization is the whole
        # point, so backfilling them would put a platform account inside a
        # tenant and trip users_org_role_check on the next boot.
        skip_superadmins = " AND role <> 'superadmin'" if table == 'users' else ''
        cur.execute(
            f"UPDATE {table} SET organization_id = %s "
            f"WHERE organization_id IS NULL{skip_superadmins}",
            (default_org_id,),
        )
        # users is the one table that legitimately holds nulls — superadmins.
        # Its equivalent guarantee is users_org_role_check below, which is
        # stricter: it also stops a non-superadmin from having a null.
        #
        # password_reset_tokens inherits the exception for the same reason it
        # exists at all: a token belongs to whoever it resets, and a superadmin
        # has no organization. NOT NULL here means the one account that sits
        # above every JCC is the one account that can never reset its password.
        # DROP is spelled out rather than merely skipped, so a database that
        # already applied NOT NULL converges on the next boot.
        if table == 'password_reset_tokens':
            cur.execute(
                f"ALTER TABLE {table} ALTER COLUMN organization_id DROP NOT NULL"
            )
        elif table != 'users':
            cur.execute(
                f"ALTER TABLE {table} ALTER COLUMN organization_id SET NOT NULL"
            )
        # Every INSERT in the app predates tenancy and names its own columns,
        # so rather than editing ~100 statements — and living with whichever
        # one got missed — the column defaults to the organization on the
        # connection. `true` makes the setting optional so it reads as NULL
        # when unset, which trips NOT NULL and fails loudly. A write with no
        # organization in scope is a bug; it must never quietly pick a tenant.
        cur.execute(f"""
            ALTER TABLE {table} ALTER COLUMN organization_id
            SET DEFAULT NULLIF(current_setting('app.organization_id', true), '')::int
        """)
        cur.execute(f"""
            DO $$ BEGIN
                ALTER TABLE {table}
                    ADD CONSTRAINT {table}_organization_fk
                    FOREIGN KEY (organization_id)
                    REFERENCES organizations(id) ON DELETE CASCADE;
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        """)
        cur.execute(
            f"CREATE INDEX IF NOT EXISTS idx_{table}_organization "
            f"ON {table}(organization_id)"
        )

    # Superadmins live above every organization, so their organization_id is
    # null; everyone else must belong to exactly one.
    cur.execute("ALTER TABLE users ALTER COLUMN organization_id DROP NOT NULL")
    cur.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check")
    cur.execute("""
        ALTER TABLE users ADD CONSTRAINT users_role_check
            CHECK (role IN ('superadmin', 'admin', 'parent', 'counselor'))
    """)
    cur.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_org_role_check")
    cur.execute("""
        ALTER TABLE users ADD CONSTRAINT users_org_role_check
            CHECK (
                (role = 'superadmin' AND organization_id IS NULL)
                OR (role <> 'superadmin' AND organization_id IS NOT NULL)
            )
    """)

    # One row of notification settings per organization.
    #
    # Not in PER_ORG_UNIQUES because that builds UNIQUE (organization_id, cols)
    # — here the organization *is* the whole key. Placed after the loop above,
    # which is what adds organization_id to the table in the first place.
    #
    # It is what makes the upsert in admin_set_notification_settings a single
    # statement: without it, two admins saving at once would each insert a row
    # and the settings would depend on which one the next SELECT happened to
    # find.
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS notification_settings_org_unique
            ON notification_settings (organization_id)
    """)

    # Rewrite the global uniques as per-organization ones.
    for table, old_constraint, columns in PER_ORG_UNIQUES:
        cur.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {old_constraint}")
        cols = ', '.join(columns)
        name = f"{table}_org_unique"
        cur.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
        cur.execute(
            f"ALTER TABLE {table} ADD CONSTRAINT {name} "
            f"UNIQUE (organization_id, {cols})"
        )

    # users.email stays globally unique on purpose. Sign-in takes an email and
    # nothing else, so a per-organization email would make the login ambiguous
    # and force the tenant picker back into the flow we deliberately removed.

    _ensure_auth_lookup(cur)
    _ensure_policies(cur)


# ─── The sign-in bootstrap ────────────────────────────────────────────────

def _ensure_auth_lookup(cur) -> None:
    """A SECURITY DEFINER window for authentication only.

    Sign-in has a chicken-and-egg problem: the organization comes from the
    user row, but with RLS on, reading that row already requires knowing the
    organization. Rather than punching a hole in the users policy — which
    would expose every row to anything that could set a flag — authentication
    goes through one function that takes an email and returns exactly the
    columns needed to verify a password and mint a token.
    """
    # The function must be owned by a role that bypasses RLS, or SECURITY
    # DEFINER buys nothing: it would run as the application role, which is
    # subject to the very policy it needs to see past. AUTH_OWNER_ROLE names
    # that role; when set, ownership is handed over after creation.
    owner = os.environ.get('AUTH_OWNER_ROLE', '')

    cur.execute("""
        CREATE OR REPLACE FUNCTION auth_lookup(p_email TEXT)
        RETURNS TABLE (
            id INTEGER,
            email TEXT,
            password_hash TEXT,
            role TEXT,
            name TEXT,
            organization_id INTEGER,
            password_set_at TIMESTAMP
        )
        LANGUAGE sql
        SECURITY DEFINER
        -- Pin the search_path so a caller can't shadow `users` with their own
        -- table and have this hand back a password hash of their choosing.
        SET search_path = public, pg_temp
        AS $$
            SELECT u.id, u.email, u.password_hash, u.role, u.name,
                   u.organization_id, u.password_set_at
              FROM users u
             WHERE lower(u.email) = lower(p_email)
             LIMIT 1
        $$;
    """)

    # The same problem, one step later in the same journey. Redeeming a
    # password-reset or invitation link is also unauthenticated: the caller
    # holds a token and nothing else, and the organization is only knowable by
    # reading the row the token points at — which RLS hides for exactly the
    # reason it hides the user row above.
    #
    # Without this, every reset link and every invitation email in the platform
    # is dead on arrival: the address is checked, the mail goes out, and the
    # link then fails to find its own token.
    #
    # Narrower than auth_lookup on purpose. It is keyed on a 32-byte secret
    # rather than on an email address, it returns no password hash, and it
    # returns only what the caller needs to pin the organization and finish the
    # reset under the ordinary policies. Expiry and used-ness are evaluated
    # here so a caller cannot ask for a stale token and get a live answer.
    cur.execute("""
        CREATE OR REPLACE FUNCTION auth_reset_lookup(p_token TEXT)
        RETURNS TABLE (
            id INTEGER,
            user_id INTEGER,
            organization_id INTEGER,
            role TEXT
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT t.id, t.user_id, u.organization_id, u.role
              FROM password_reset_tokens t
              JOIN users u ON u.id = t.user_id
             WHERE t.token = p_token
               AND t.used = 0
               AND t.expires_at > NOW()
             LIMIT 1
        $$;
    """)

    if owner:
        # Bypassing RLS is not the same as being allowed to read the table.
        # The owner role has no privileges of its own, so SECURITY DEFINER
        # would run past the policy and then be refused outright.
        cur.execute(f'GRANT SELECT ON users TO "{owner}"')
        cur.execute(f'GRANT SELECT ON password_reset_tokens TO "{owner}"')
        # Idempotent: re-running with the ownership already handed over is a
        # no-op. Quoted as an identifier so a stray value can't inject SQL.
        cur.execute(f'ALTER FUNCTION auth_lookup(TEXT) OWNER TO "{owner}"')
        cur.execute(f'ALTER FUNCTION auth_reset_lookup(TEXT) OWNER TO "{owner}"')
        # The application role can no longer replace the function once it
        # doesn't own it, so grant it the right to call it.
        cur.execute('GRANT EXECUTE ON FUNCTION auth_lookup(TEXT) TO PUBLIC')
        cur.execute('GRANT EXECUTE ON FUNCTION auth_reset_lookup(TEXT) TO PUBLIC')


# ─── Row level security ───────────────────────────────────────────────────

# Reads and writes are allowed when the row belongs to the pinned
# organization, or when the connection is acting for a Kikar superadmin.
_ORG_PREDICATE = """(
    current_setting('app.is_superadmin', true) = 'on'
    OR organization_id = NULLIF(current_setting('app.organization_id', true), '')::int
)"""


def _ensure_policies(cur) -> None:
    for table in TENANT_TABLES:
        cur.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        # FORCE so the table owner is subject to its own policies. Without it
        # RLS is skipped for the owner, and in a managed Postgres the app
        # frequently *is* the owner.
        cur.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        cur.execute(f"DROP POLICY IF EXISTS org_isolation ON {table}")
        cur.execute(f"""
            CREATE POLICY org_isolation ON {table}
                USING {_ORG_PREDICATE}
                WITH CHECK {_ORG_PREDICATE}
        """)

    # An organization can see itself; a superadmin sees all of them.
    cur.execute("ALTER TABLE organizations ENABLE ROW LEVEL SECURITY")
    cur.execute("ALTER TABLE organizations FORCE ROW LEVEL SECURITY")
    cur.execute("DROP POLICY IF EXISTS org_self ON organizations")
    cur.execute("""
        CREATE POLICY org_self ON organizations
            USING (
                current_setting('app.is_superadmin', true) = 'on'
                OR id = NULLIF(current_setting('app.organization_id', true), '')::int
            )
            WITH CHECK (current_setting('app.is_superadmin', true) = 'on')
    """)

    # Superadmin only, in both directions. These rows describe organizations
    # that no longer exist, so the ordinary "belongs to my organization" test
    # has nothing left to match against — leaving the table unpoliced would
    # make every JCC's deletion record, and its photo paths, readable by any
    # signed-in connection.
    cur.execute("ALTER TABLE organization_deletions ENABLE ROW LEVEL SECURITY")
    cur.execute("ALTER TABLE organization_deletions FORCE ROW LEVEL SECURITY")
    cur.execute("DROP POLICY IF EXISTS superadmin_only ON organization_deletions")
    cur.execute("""
        CREATE POLICY superadmin_only ON organization_deletions
            USING (current_setting('app.is_superadmin', true) = 'on')
            WITH CHECK (current_setting('app.is_superadmin', true) = 'on')
    """)


def rls_is_enforced(cur) -> bool:
    """Whether the connected role is actually subject to RLS.

    A role with BYPASSRLS ignores every policy above, which would leave the
    isolation looking configured while doing nothing. Callers should shout
    rather than assume.
    """
    cur.execute("SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user")
    row = cur.fetchone()
    if row is None:
        return False
    bypasses = row['rolbypassrls'] if isinstance(row, dict) else row[0]
    return not bypasses
