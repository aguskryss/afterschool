import psycopg2
import psycopg2.extras
import psycopg2.pool
import os
import time

try:
    from server import tenancy
except ImportError:  # running from inside server/
    import tenancy

DATABASE_URL = os.environ.get('DATABASE_URL', '')

# init_db() creates and alters tables and defines a SECURITY DEFINER function,
# which the low-privilege application role deliberately cannot do. When an
# owner URL is provided, schema work uses it and every request still goes
# through DATABASE_URL — so RLS is enforced at runtime.
ADMIN_DATABASE_URL = os.environ.get('ADMIN_DATABASE_URL') or DATABASE_URL

_pool = None

def _get_pool():
    global _pool
    if _pool is None:
        # Supabase's session-mode pooler caps at 15 concurrent clients on the
        # default tier. During a Render rolling deploy the old and new containers
        # run simultaneously, plus init_db() opens one standalone connection of
        # its own — so the combined session count must stay under 15.
        #   2 containers * maxconn 5 = 10  +  init_db standalone = 11  < 15  ✓
        # The previous 8 cap let two containers + init_db reach 17 and the new
        # container crashed at boot with (EMAXCONNSESSION). minconn=1 keeps
        # the cold-start footprint tiny so the old container has every chance
        # to release its idle slots before the new one warms up.
        _pool = psycopg2.pool.ThreadedConnectionPool(
            minconn=1, maxconn=5, dsn=DATABASE_URL,
            cursor_factory=psycopg2.extras.RealDictCursor
        )
    return _pool

class DbConnection:
    """Thin wrapper around psycopg2 that mimics sqlite3 connection.execute() pattern."""
    def __init__(self, conn, pooled=False):
        self._conn = conn
        self._pooled = pooled

    def execute(self, sql, params=None):
        cur = self._conn.cursor()
        cur.execute(sql, params or ())
        return cur

    def commit(self):
        self._conn.commit()

    def rollback(self):
        self._conn.rollback()

    def close(self):
        if self._pooled:
            # Always clear the tenant before the connection goes back in the
            # pool. If this is skipped, the next request to borrow it inherits
            # the previous request's organization — the failure mode where one
            # JCC silently reads another's rows.
            try:
                _apply_organization(self._conn, None, False)
            except Exception:
                # A poisoned connection must not be reused; drop it instead.
                _get_pool().putconn(self._conn, close=True)
                return
            _get_pool().putconn(self._conn)
        else:
            self._conn.close()


# Organization for code running outside a request (init_db, seed scripts).
# Requests use flask.g instead — see _resolve_organization.
_script_organization_id = None

# Background threads outlive the request that started them and have no
# flask.g, so they carry their tenant here. Without this a worker thread would
# fall through to the script default and write into the wrong organization.
import threading as _threading
_thread_local = _threading.local()


def set_script_organization(organization_id):
    global _script_organization_id
    _script_organization_id = organization_id


def set_thread_organization(organization_id):
    """Pin the calling thread to one organization for its whole life."""
    _thread_local.organization_id = organization_id
    _thread_local.is_superadmin = False


def set_thread_superadmin():
    """Let this thread read across every organization.

    For background work whose whole job is deciding which organizations need
    something — the scheduler looking for who is due. Pinned to one tenant it
    would see one tenant; pinned to none it would see nothing, because
    organizations carries FORCE ROW LEVEL SECURITY and the owner role is
    subject to the same policy as anyone else.

    Use it to *find* work and then narrow: set_thread_organization() before
    touching that organization's rows, so a query written later cannot quietly
    read across tenants because the thread was still wide open.
    """
    _thread_local.organization_id = None
    _thread_local.is_superadmin = True


def _resolve_organization():
    """Which organization the next connection should be pinned to.

    Returns (organization_id, is_superadmin). A superadmin has no organization
    of their own and is allowed across all of them, so the two travel together.
    """
    try:
        from flask import g, has_request_context
        if has_request_context():
            return (getattr(g, 'organization_id', None),
                    bool(getattr(g, 'is_superadmin', False)))
    except Exception:
        pass
    if getattr(_thread_local, 'is_superadmin', False):
        return None, True
    thread_org = getattr(_thread_local, 'organization_id', None)
    if thread_org is not None:
        return thread_org, False
    return _script_organization_id, False


def _apply_organization(conn, organization_id, is_superadmin=False):
    with conn.cursor() as cur:
        cur.execute(
            "SELECT set_config('app.organization_id', %s, false),"
            "       set_config('app.is_superadmin', %s, false)",
            ('' if organization_id is None else str(organization_id),
             'on' if is_superadmin else 'off'),
        )


def get_db():
    conn = _get_pool().getconn()
    conn.autocommit = True
    _apply_organization(conn, *_resolve_organization())
    return DbConnection(conn, pooled=True)

def get_db_transaction():
    """Get a connection with autocommit OFF for transactions."""
    conn = _get_pool().getconn()
    conn.autocommit = False
    _apply_organization(conn, *_resolve_organization())
    return DbConnection(conn, pooled=True)

def _connect_with_retry(dsn, attempts=6, base_delay=2.0):
    """Open a standalone psycopg2 connection, retrying on transient errors.

    Render rolling deploys spin up the new container while the old one still
    holds Supabase pooler slots. If the combined session count is briefly at
    the 15-client cap, the new container's first connect() fails with
    (EMAXCONNSESSION) and gunicorn exits with status 1 — that's what took
    the app down on 2026-05-12. Retrying with backoff covers the few seconds
    until the old container's slots release.
    """
    last_err = None
    for i in range(attempts):
        try:
            return psycopg2.connect(dsn, cursor_factory=psycopg2.extras.RealDictCursor)
        except psycopg2.OperationalError as e:
            last_err = e
            msg = str(e)
            # Only retry on capacity / connectivity blips. Bad creds, missing
            # DB, etc. should fail fast.
            transient = ('EMAXCONNSESSION' in msg
                         or 'max clients reached' in msg
                         or 'too many connections' in msg
                         or 'could not connect to server' in msg
                         or 'timeout expired' in msg)
            if not transient or i == attempts - 1:
                raise
            delay = base_delay * (2 ** i)
            print(f"[init_db] transient connect failure ({e.__class__.__name__}): {msg.strip()[:200]} — retry {i + 1}/{attempts - 1} in {delay:.1f}s")
            time.sleep(delay)
    raise last_err  # unreachable, but keeps type-checkers happy


def _add_check(cur, table, name, expression):
    """Add a named CHECK constraint, ignoring one that is already there.

    ADD CONSTRAINT has no IF NOT EXISTS, and init_db() runs on every boot, so
    the second boot would abort the whole bootstrap on a duplicate_object. The
    savepoint is what makes the failure survivable: without it the aborted
    statement poisons the surrounding transaction and everything after this
    point rolls back too.
    """
    cur.execute(f"SAVEPOINT add_{name}")
    try:
        cur.execute(f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({expression})")
    except psycopg2.errors.DuplicateObject:
        cur.execute(f"ROLLBACK TO SAVEPOINT add_{name}")
    else:
        cur.execute(f"RELEASE SAVEPOINT add_{name}")


def init_db():
    conn = _connect_with_retry(ADMIN_DATABASE_URL)
    cur = conn.cursor()

    # Schema bootstrap runs above every organization: it creates the first one,
    # seeds the platform accounts, and reads rows back to check its own work.
    # Now that this connects as the ordinary application role rather than a
    # superuser, it is subject to the policies it just installed — without this
    # it would create an organization and then be unable to see it. The
    # connection is standalone and closed at the end, so the flag can't leak
    # into a request.
    cur.execute("SELECT set_config('app.is_superadmin', 'on', false)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id SERIAL PRIMARY KEY,
            email TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('admin', 'parent', 'counselor')),
            name TEXT NOT NULL,
            phone TEXT DEFAULT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS schools (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL
        )
    """)

    # The menu a child's grade is picked from (sql/49_add_grades.sql). Not
    # where a child's own grade is stored — that stays grade_label/grade_num
    # on children, filled in by parse_grade() either way. This is only the
    # list an admin manages so the picker isn't free text.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS grades (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS counselor_schools (
            counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
            PRIMARY KEY (counselor_id, school_id)
        )
    """)

    # When an assignment applies, and who made it
    # (sql/33_add_counselor_assignment_dates.sql). Both dates NULL is
    # permanent, which is what every row written before this was.
    #
    # The end date creates a state the fail-open rule in
    # counselor_school_ids() must not confuse with the old one: a counselor
    # with NO rows covers every school, but a counselor whose rows have all
    # expired covers none. Reading the second as the first would hand someone
    # the whole organization at midnight.
    cur.execute("ALTER TABLE counselor_schools ADD COLUMN IF NOT EXISTS effective_from DATE")
    cur.execute("ALTER TABLE counselor_schools ADD COLUMN IF NOT EXISTS effective_to DATE")
    cur.execute("ALTER TABLE counselor_schools ADD COLUMN IF NOT EXISTS assigned_by INTEGER REFERENCES users(id) ON DELETE SET NULL")
    cur.execute("ALTER TABLE counselor_schools ADD COLUMN IF NOT EXISTS assigned_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP")
    _add_check(cur, 'counselor_schools', 'counselor_schools_window_check',
               "effective_from IS NULL OR effective_to IS NULL "
               "OR effective_from <= effective_to")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_counselor_schools_school ON counselor_schools(school_id)")

    # The log. school_id carries no foreign key on purpose: deleting a school
    # must not erase the record that someone was assigned to it, and the names
    # are captured at write time so a line still reads after the row it
    # describes is gone.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS counselor_school_changes (
            id SERIAL PRIMARY KEY,
            counselor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            counselor_name TEXT NOT NULL,
            school_id INTEGER,
            school_name TEXT NOT NULL,
            action TEXT NOT NULL,
            effective_from DATE,
            effective_to DATE,
            changed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            changed_by_name TEXT NOT NULL,
            changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    _add_check(cur, 'counselor_school_changes', 'counselor_school_changes_action_check',
               "action IN ('added','removed','updated')")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_counselor_school_changes_counselor "
                "ON counselor_school_changes(counselor_id, changed_at DESC)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_counselor_school_changes_at "
                "ON counselor_school_changes(changed_at DESC)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS children (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            school_id INTEGER NOT NULL REFERENCES schools(id),
            service_type TEXT NOT NULL DEFAULT 'Full Service',
            release_group TEXT DEFAULT NULL,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # What a real roster carries and this table never had room for
    # (sql/29_add_daily_ops_foundation.sql). All nullable: an organization that
    # doesn't upload one of these rosters simply has none of it.
    #
    # There is deliberately no `status` column. The spec asks for
    # active/withdrawn, and `active` above already is that — it is what every
    # roster, attendance, pickup and parent query filters on. A second column
    # that can disagree with it would eventually put a withdrawn child on a bus
    # manifest. withdrawn_at/_reason carry the provenance instead.
    #
    # grade_label keeps the roster's own spelling ('K', '0', '3'); grade_num is
    # what grade-range rules compare against, with K and 0 both landing on 0.
    # Both, so that collapse stays reversible.
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS first_name TEXT")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS last_name TEXT")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS grade_label TEXT")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS grade_num SMALLINT")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS dob DATE")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS sex TEXT")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS allergies TEXT")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS bus_rider BOOLEAN")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS notes TEXT")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS arrival_mode TEXT")
    # The roster's billing-notes column, kept verbatim and wired to nothing.
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS roster_flag TEXT")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS withdrawn_at TIMESTAMP")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS withdrawn_reason TEXT")
    _add_check(cur, 'children', 'children_sex_check',
               "sex IS NULL OR sex IN ('M','F')")
    # 'dropoff' is a parent dropping the child at the JCC; 'bus' is the JCC bus
    # collecting them from school. The roster encodes this as a "- Drop Off"
    # suffix on the school name, which the importer splits off.
    _add_check(cur, 'children', 'children_arrival_mode_check',
               "arrival_mode IS NULL OR arrival_mode IN ('bus','dropoff')")

    # ─── Private admin notes (sql/53_add_child_notes.sql) ─────────────────
    # Deliberately not a column on `children`: the existing `notes` column
    # already rides along in /api/counselor/roster's SELECT, so anything
    # written there is one future counselor screen away from being visible
    # to staff. Its own table is never selected into a counselor- or
    # parent-facing response anywhere in app.py — every route reading or
    # writing it is require_admin() — which is what makes "admin-only" a
    # property of the schema rather than a habit every future query has to
    # remember.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS child_notes (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            author_name TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_child_notes_child "
        "ON child_notes(child_id, created_at DESC)"
    )

    cur.execute("""
        CREATE TABLE IF NOT EXISTS registrations (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            day_of_week TEXT NOT NULL CHECK(day_of_week IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
            UNIQUE(child_id, day_of_week)
        )
    """)

    # The hour a child is collected — 3, 4, 5 or 6pm. The sign-out sheet groups
    # by it, the bus manifest orders by it, and the rule that decides whether a
    # child waits in a care room or is handed straight to a parent compares the
    # class end time against it.
    #
    # Nullable, and that is load-bearing: for every other JCC a registrations
    # row means "enrolled this weekday" and nothing more. A default would invent
    # a pickup hour for all of their rows. NULL means "this organization does
    # not use dismissal times" and must never be read as 6.
    cur.execute("ALTER TABLE registrations ADD COLUMN IF NOT EXISTS dismissal_time SMALLINT")
    _add_check(cur, 'registrations', 'registrations_dismissal_time_check',
               "dismissal_time IS NULL OR dismissal_time BETWEEN 3 AND 6")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS absences (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            absence_date TEXT NOT NULL,
            marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(child_id, absence_date)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS recurring_absences (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            day_of_week TEXT NOT NULL CHECK(day_of_week IN ('Monday','Tuesday','Wednesday','Thursday','Friday')),
            start_date TEXT NOT NULL,
            end_date TEXT,
            marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(child_id, day_of_week)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS absence_exceptions (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            exception_date TEXT NOT NULL,
            marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(child_id, exception_date)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS invitations (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token TEXT UNIQUE NOT NULL,
            used INTEGER DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS attendance_records (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            school_id INTEGER NOT NULL REFERENCES schools(id),
            attendance_date TEXT NOT NULL,
            on_bus INTEGER NOT NULL DEFAULT 0,
            submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            submitted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(child_id, attendance_date)
        )
    """)

    # Arrival and departure times (sql/19_add_attendance_times.sql), behind the
    # check_in_out module. `on_bus` stays the answer to "is this child here" —
    # the roster upload parser writes it and these columns are additional, not
    # a replacement. checked_out_at is stamped by the pickup release, which is
    # why the columns have to exist before secure_pickup ships.
    cur.execute("ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checked_in_at TIMESTAMP")
    cur.execute("ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS checked_out_at TIMESTAMP")

    # Where the child actually is, and who said so
    # (sql/31_add_child_status.sql). `on_bus` was a boolean doing four jobs —
    # the tap at school, "is this child here", the headcount numerator, and
    # (because a release sets it to 1) a child who left an hour ago.
    #
    # NULL means no status was recorded, and the readers fall back to on_bus
    # and checked_out_at exactly as they did before, so applying this changes
    # no number on any screen. on_bus stays authoritative for every existing
    # query; _ON_BUS_FOR_STATUS in server/app.py is the one place that keeps
    # the two consistent.
    #
    # There is no status_school_id: school_id above already records the school
    # the row was written against, and a second column for one fact eventually
    # puts a child in two places.
    cur.execute("ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS status TEXT")
    cur.execute("ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS status_at TIMESTAMP")
    cur.execute("ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS status_by INTEGER REFERENCES users(id) ON DELETE SET NULL")
    cur.execute("ALTER TABLE attendance_records ADD COLUMN IF NOT EXISTS status_note TEXT")
    _add_check(cur, 'attendance_records', 'attendance_records_status_check',
               "status IS NULL OR status IN "
               "('waiting','picked_up','checked_out','absent','not_found','issue')")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_attendance_records_status "
                "ON attendance_records(attendance_date, status)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS parent_notifications (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            sent_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            notification_date TEXT NOT NULL,
            message TEXT NOT NULL,
            response TEXT,
            responded_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS calendar_events (
            id SERIAL PRIMARY KEY,
            event_date TEXT NOT NULL,
            event_type TEXT NOT NULL DEFAULT 'special_event',
            title TEXT NOT NULL,
            description TEXT,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS password_reset_tokens (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            token TEXT UNIQUE NOT NULL,
            used INTEGER DEFAULT 0,
            expires_at TIMESTAMP NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS push_subscriptions (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            endpoint TEXT NOT NULL,
            p256dh TEXT NOT NULL,
            auth TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_id, endpoint)
        )
    """)

    # Two-Factor Authentication
    cur.execute("""
        CREATE TABLE IF NOT EXISTS user_totp (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
            secret TEXT NOT NULL,
            enabled INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Failed login tracking for account lockout
    cur.execute("""
        CREATE TABLE IF NOT EXISTS login_attempts (
            id SERIAL PRIMARY KEY,
            email TEXT NOT NULL,
            ip_address TEXT,
            attempted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # Rate-limit lookup runs `WHERE ip_address = %s AND attempted_at > NOW() -
    # INTERVAL '15 minutes'` on every login. Without this index the query is a
    # full table scan that grows unbounded over time.
    cur.execute("CREATE INDEX IF NOT EXISTS idx_login_attempts_ip_date ON login_attempts(ip_address, attempted_at)")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS pickup_notifications (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            parent_name TEXT NOT NULL,
            child_name TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Claim fields on pickup_notifications (idempotent migration).
    # A pickup is "unclaimed" when claimed_by IS NULL. The first counselor/admin to
    # tap "I've Got This" sets these fields atomically; everyone else's view clears.
    cur.execute("ALTER TABLE pickup_notifications ADD COLUMN IF NOT EXISTS claimed_by INTEGER REFERENCES users(id) ON DELETE SET NULL")
    cur.execute("ALTER TABLE pickup_notifications ADD COLUMN IF NOT EXISTS claimed_by_name TEXT")
    cur.execute("ALTER TABLE pickup_notifications ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMP")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_pickup_notifications_unclaimed ON pickup_notifications(created_at) WHERE claimed_by IS NULL")

    # Flag marking rows added by the most recent roster upload. Reset on every
    # upload; set only for rows INSERTed by that upload (never by manual
    # "+ Add Parent" / "+ Child" actions). Drives the "NEW" pill in the admin UI.
    cur.execute("ALTER TABLE users    ADD COLUMN IF NOT EXISTS is_new INTEGER NOT NULL DEFAULT 0")
    cur.execute("ALTER TABLE children ADD COLUMN IF NOT EXISTS is_new INTEGER NOT NULL DEFAULT 0")

    # Set when a user first completes the password-setup flow (via reset-password
    # endpoint). Drives the activation status badge in the admin parents tab.
    # Backfilled on successful login for users that pre-date this column.
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS password_set_at TIMESTAMP")

    # Set when an invitation email is *successfully* delivered to the user (i.e.
    # send_invitation returned True). This is intentionally distinct from the
    # creation of a password_reset_tokens row, because tokens get issued
    # synchronously up-front (even for the bulk job) but the actual SMTP/Resend
    # send may fail. The admin parents tab uses this to distinguish "no invite
    # sent yet" from "invite sent, waiting for setup".
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS invited_at TIMESTAMP")

    # Stamped on every fully successful sign-in (after 2FA, if enabled) — see
    # sql/55_add_last_login_at.sql. NULL means "never signed in since this
    # shipped", which the admin Parents/Counselors screens show as "Never"
    # rather than treating as a missing value to backfill.
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ")

    # A parent's own opt-in to a second notification channel, on top of the
    # organization-level switches in notification_settings — see
    # sql/59_add_email_notifications.sql. FALSE for everyone until they turn
    # it on in Account.
    cur.execute("ALTER TABLE users ADD COLUMN IF NOT EXISTS email_notifications "
                "BOOLEAN NOT NULL DEFAULT FALSE")

    # Per-school roster split declaration. 'grade' = K-1st / 2-5th split,
    # 'torah' = Torah / Regular split, 'none' = no split. This is the
    # authoritative source for the counselor view; the roster parser also
    # coerces incoming rows against it so dirty column-L data can't mis-tag
    # a child (e.g. a Ben Gamla row arriving with "K-1st" in column L).
    cur.execute("ALTER TABLE schools ADD COLUMN IF NOT EXISTS division_type TEXT NOT NULL DEFAULT 'none'")

    # Audit trail for every claim / unclaim action. Not shown in UI yet; kept
    # for admin review. Survives unclaim + reclaim cycles.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS pickup_claim_audit (
            id SERIAL PRIMARY KEY,
            pickup_id INTEGER NOT NULL REFERENCES pickup_notifications(id) ON DELETE CASCADE,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            user_name TEXT NOT NULL,
            action TEXT NOT NULL CHECK(action IN ('claim', 'unclaim')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_pickup_claim_audit_pickup ON pickup_claim_audit(pickup_id)")

    # ─── Secure pickup (sql/21_add_secure_pickup.sql) ─────────────────────
    # The `secure_pickup` module. Independent of the pickup_notifications
    # queue above: a JCC can run the announce-then-claim queue, this release
    # flow, both, or neither. Nothing here replaces anything there.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS authorized_pickup_people (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            name TEXT NOT NULL,
            relationship TEXT,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(child_id, name)
        )
    """)
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_authorized_pickup_child "
        "ON authorized_pickup_people(child_id)"
    )

    # person_name and person_relationship are denormalised on purpose. This is
    # the record of who took a child home; it has to survive the parent later
    # removing that person from their list. A join that resolves to NULL six
    # months from now is not an answer to "who picked up my daughter".
    cur.execute("""
        CREATE TABLE IF NOT EXISTS pickup_releases (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            person_id INTEGER REFERENCES authorized_pickup_people(id) ON DELETE SET NULL,
            person_name TEXT NOT NULL,
            person_relationship TEXT,
            counselor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            counselor_name TEXT NOT NULL,
            release_date TEXT NOT NULL,
            released_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(child_id, release_date)
        )
    """)
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_pickup_releases_date "
        "ON pickup_releases(release_date)"
    )

    # sql/27_add_pickup_signatures.sql. The person collecting the child signs
    # on the counselor's device, and the bytes land here rather than in the
    # photo bucket: this row is written inside the same transaction that closes
    # the child's attendance, and an object store cannot join that transaction.
    # A release with no signature, or a signature with no release, is the one
    # outcome this record cannot afford.
    #
    # Nullable even though the application requires a signature — releases
    # written before this column existed have none, and the admin log reads
    # `signature IS NULL` to say so rather than showing an empty frame.
    cur.execute("ALTER TABLE pickup_releases ADD COLUMN IF NOT EXISTS signature BYTEA")
    cur.execute("ALTER TABLE pickup_releases ADD COLUMN IF NOT EXISTS signature_mime TEXT")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS activities (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            category TEXT,
            sub_type TEXT,
            season TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS activity_schedules (
            id SERIAL PRIMARY KEY,
            activity_name_pattern TEXT NOT NULL,
            day_of_week TEXT NOT NULL,
            dropoff_time TEXT,
            pickup_time TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(activity_name_pattern, day_of_week)
        )
    """)

    # Admin → parents broadcast messages.
    # admin_messages    : the source record (one row per composed message).
    # admin_message_schools : audience filter when audience_type = 'schools'.
    #                          Empty when audience_type = 'all'.
    # parent_messages   : per-recipient copy. Lets each parent independently
    #                     mark as read or soft-delete without affecting other
    #                     recipients' inboxes.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS admin_messages (
            id SERIAL PRIMARY KEY,
            sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            subject TEXT NOT NULL,
            body TEXT NOT NULL,
            audience_type TEXT NOT NULL CHECK(audience_type IN ('all','schools')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS admin_message_schools (
            admin_message_id INTEGER NOT NULL REFERENCES admin_messages(id) ON DELETE CASCADE,
            school_id INTEGER NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
            PRIMARY KEY (admin_message_id, school_id)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS parent_messages (
            id SERIAL PRIMARY KEY,
            admin_message_id INTEGER NOT NULL REFERENCES admin_messages(id) ON DELETE CASCADE,
            parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            read_at TIMESTAMP,
            deleted_at TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_parent_messages_parent ON parent_messages(parent_id, deleted_at, read_at)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_parent_messages_admin_msg ON parent_messages(admin_message_id)")

    # ─── Two-way messaging (sql/23_add_parent_messaging.sql) ──────────────
    # The `parent_messaging` module. Separate from admin_messages above, which
    # is a one-way broadcast and stays exactly as it is: one announcement fans
    # out to many parents, while this is one conversation with one family.
    # Folding them together would mean either giving every broadcast a reply
    # box or pretending a thread has an audience.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS parent_threads (
            id SERIAL PRIMARY KEY,
            parent_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            last_message_at TIMESTAMP,
            parent_unread INTEGER NOT NULL DEFAULT 0,
            admin_unread INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(parent_id)
        )
    """)
    # The unread counts live on the thread rather than being COUNT(*)'d per
    # read: the admin's inbox lists every thread at once and can't pay a
    # subquery per row.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS thread_messages (
            id SERIAL PRIMARY KEY,
            thread_id INTEGER NOT NULL REFERENCES parent_threads(id) ON DELETE CASCADE,
            sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            sender_role TEXT NOT NULL CHECK(sender_role IN ('parent', 'admin')),
            sender_name TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_thread_messages_thread "
        "ON thread_messages(thread_id, created_at)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_parent_threads_recent "
        "ON parent_threads(last_message_at DESC NULLS LAST)"
    )

    # ─── Two-way messaging, staff side (sql/51_add_staff_messaging.sql) ───
    # The `staff_messaging` module. Same shape as parent_threads/thread_messages
    # above — one thread per person, both directions — but the person is a
    # counselor and the other side is always the admin. Its own pair of tables
    # rather than a row in parent_threads: that one's sender_role CHECK only
    # allows ('parent','admin'), and a counselor is neither, and folding staff
    # into "parent" threads would let a counselor's messages surface on a
    # screen built for families.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS staff_threads (
            id SERIAL PRIMARY KEY,
            counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            last_message_at TIMESTAMP,
            counselor_unread INTEGER NOT NULL DEFAULT 0,
            admin_unread INTEGER NOT NULL DEFAULT 0,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(counselor_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS staff_thread_messages (
            id SERIAL PRIMARY KEY,
            thread_id INTEGER NOT NULL REFERENCES staff_threads(id) ON DELETE CASCADE,
            sender_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            sender_role TEXT NOT NULL CHECK(sender_role IN ('counselor', 'admin')),
            sender_name TEXT NOT NULL,
            body TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_staff_thread_messages_thread "
        "ON staff_thread_messages(thread_id, created_at)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_staff_threads_recent "
        "ON staff_threads(last_message_at DESC NULLS LAST)"
    )

    # ─── Daily photos (sql/25_add_photos.sql) ─────────────────────────────
    # The `photos` module. The image bytes live in Supabase Storage (see
    # server/photo_storage.py); these rows hold the path and who is in the
    # picture. A photo with no tags is visible to no parent — which is the
    # safe default, not a bug.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS photos (
            id SERIAL PRIMARY KEY,
            storage_path TEXT NOT NULL UNIQUE,
            uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            photo_date TEXT NOT NULL,
            caption TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS photo_tags (
            photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            PRIMARY KEY (photo_id, child_id)
        )
    """)
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_photos_date ON photos(photo_date DESC)"
    )
    cur.execute(
        "CREATE INDEX IF NOT EXISTS idx_photo_tags_child ON photo_tags(child_id)"
    )

    cur.execute("""
        CREATE TABLE IF NOT EXISTS activity_roster (
            id SERIAL PRIMARY KEY,
            activity_id INTEGER NOT NULL REFERENCES activities(id) ON DELETE CASCADE,
            child_name TEXT NOT NULL,
            school TEXT,
            option_type TEXT,
            grade_group TEXT,
            action TEXT NOT NULL CHECK(action IN ('Drop Off', 'Pick Up')),
            day_of_week TEXT NOT NULL,
            action_time TEXT,
            counselor_name TEXT,
            assigned_counselor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            season TEXT,
            source TEXT NOT NULL DEFAULT 'excel',
            specific_date DATE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)
    # One-shot make-up class entries: NULL = recurring (matches by day_of_week);
    # set = entry only applies on that single calendar date. Read-side filters
    # hide rows whose specific_date is in the past, and the manual-entries GET
    # opportunistically deletes them so they "disappear" after their day.
    cur.execute("ALTER TABLE activity_roster ADD COLUMN IF NOT EXISTS specific_date DATE")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_activity_roster_specific_date ON activity_roster(specific_date) WHERE specific_date IS NOT NULL")

    # Parent-submitted make-up classes (sql/10_add_makeup_class_parent_source.sql).
    # Rows with source='parent_makeup' are created by parents from their portal;
    # the four columns below carry the audit + auto-assignment metadata.
    cur.execute("ALTER TABLE activity_roster ADD COLUMN IF NOT EXISTS requested_by_parent_id INTEGER REFERENCES users(id) ON DELETE SET NULL")
    cur.execute("ALTER TABLE activity_roster ADD COLUMN IF NOT EXISTS parent_will_pickup BOOLEAN NOT NULL DEFAULT FALSE")
    cur.execute("ALTER TABLE activity_roster ADD COLUMN IF NOT EXISTS counselor_locked BOOLEAN NOT NULL DEFAULT FALSE")
    cur.execute("ALTER TABLE activity_roster ADD COLUMN IF NOT EXISTS admin_seen_at TIMESTAMP")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_activity_roster_parent_makeup ON activity_roster(specific_date, admin_seen_at) WHERE source='parent_makeup'")

    cur.execute("""
        CREATE TABLE IF NOT EXISTS activity_completions (
            id SERIAL PRIMARY KEY,
            roster_entry_id INTEGER NOT NULL REFERENCES activity_roster(id) ON DELETE CASCADE,
            completion_date TEXT NOT NULL,
            counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            completed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(roster_entry_id, completion_date)
        )
    """)

    # Counselor day-off requests (sql/14_add_counselor_time_off.sql).
    # One row per (counselor, off_date) that is pending or approved; rejected
    # and cancelled rows are kept for history and do not block re-submission.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS counselor_time_off (
            id SERIAL PRIMARY KEY,
            counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            off_date DATE NOT NULL,
            reason TEXT,
            status TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','approved','rejected','cancelled')),
            reviewed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            reviewed_at TIMESTAMP,
            review_note TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Per-date roster reassignment. When a recurring activity_roster entry
    # needs a different counselor on a specific date (e.g. the assigned
    # counselor has an approved time-off), we insert one row here instead of
    # mutating the recurring row. Roster reads LEFT JOIN this table and use
    # COALESCE(overrides.assigned_counselor_id, activity_roster.assigned_counselor_id).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS activity_roster_overrides (
            id SERIAL PRIMARY KEY,
            roster_entry_id INTEGER NOT NULL REFERENCES activity_roster(id) ON DELETE CASCADE,
            override_date DATE NOT NULL,
            assigned_counselor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            reason TEXT NOT NULL DEFAULT 'manual'
                CHECK (reason IN ('time_off','manual')),
            source_time_off_id INTEGER REFERENCES counselor_time_off(id) ON DELETE SET NULL,
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(roster_entry_id, override_date)
        )
    """)

    # ─── JCCSN daily ops (sql/29_add_daily_ops_foundation.sql) ───────────────
    # Nothing reads these yet. They are the schema the roster importer and the
    # derived daily views need, behind the `daily_ops` module.

    # One school, several spellings: the roster says "Village" where the
    # attendance workbook says "M - V". A NULL school_id records a token that
    # was seen and deliberately left unmapped, so the next upload stops asking.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS school_aliases (
            id SERIAL PRIMARY KEY,
            alias TEXT NOT NULL,
            alias_norm TEXT NOT NULL UNIQUE,
            school_id INTEGER REFERENCES schools(id) ON DELETE CASCADE,
            arrival_mode TEXT CHECK (arrival_mode IS NULL OR arrival_mode IN ('bus','dropoff')),
            source TEXT NOT NULL DEFAULT 'import' CHECK (source IN ('import','manual')),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # children.parent_id is untouched and still means "the account whose parent
    # portal shows this child" — it points at contact 1. user_id here was the
    # seam for the day contact 2 gets a portal too (sql/61 is that day: every
    # parent-facing request now also checks this column).
    cur.execute("""
        CREATE TABLE IF NOT EXISTS child_contacts (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            priority SMALLINT NOT NULL CHECK (priority IN (1,2)),
            name TEXT NOT NULL,
            phone TEXT,
            email TEXT,
            user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(child_id, priority)
        )
    """)
    # Partial: most rows (every priority-1 row, and any unlinked priority-2
    # row) have user_id NULL and are never looked up by it.
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_child_contacts_user
            ON child_contacts(user_id) WHERE user_id IS NOT NULL
    """)

    # Rows rather than ten columns: the real cells hold a date, or 'x', or
    # 'n/a', or 'MISSING', or a medication name, so a typed column would be
    # TEXT anyway — and the withdrawn sheet tracks eight items, not ten.
    # raw_value keeps the cell verbatim; a blank cell writes no row at all.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS child_compliance (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            item TEXT NOT NULL CHECK (item IN (
                'registration','registration_fee','membership','pickup_form',
                'first_aid','medication','photo','physical','immunization',
                'complete','bday_card')),
            status TEXT NOT NULL CHECK (status IN (
                'done','pending','waived','na','missing','other')),
            recorded_on DATE,
            raw_value TEXT,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(child_id, item)
        )
    """)

    cur.execute("""
        CREATE TABLE IF NOT EXISTS rooms (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL UNIQUE,
            capacity_hint INTEGER,
            sort_order INTEGER NOT NULL DEFAULT 100,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    """)

    # Admin-configured, not a fixed algorithm: the grade split moves with the
    # headcount. NULL day_of_week is the every-weekday rule. Overlaps are legal
    # and resolved in the application — day-specific first, then the narrower
    # grade range, then priority — so a one-day exception can sit on top of the
    # standard week without deleting the standard week.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS care_assignment_rules (
            id SERIAL PRIMARY KEY,
            day_of_week TEXT CHECK (day_of_week IS NULL OR day_of_week IN
                ('Monday','Tuesday','Wednesday','Thursday','Friday')),
            time_block TEXT NOT NULL CHECK (time_block IN ('3-4','4-5','5-6')),
            grade_min SMALLINT NOT NULL,
            grade_max SMALLINT NOT NULL,
            room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
            priority SMALLINT NOT NULL DEFAULT 100,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CHECK (grade_min <= grade_max)
        )
    """)

    # The class catalog (sql/35, re-keyed in sql/39). Identity is
    # (name, weekday, start time): "Chess" on Monday and "Chess" on Wednesday
    # are two rows, because they can have different hours, rooms and rosters,
    # and so are the two sittings of "HW Club" that both run on a Tuesday. The
    # unique is built per organization by class_sessions_org_unique, below.
    #
    # The times are nullable because a class can be named without them — the
    # admin adds "Chess" on the Classes screen and fills the hours in after. The
    # roster itself does carry them: Heather's file writes them into the name,
    # `Soccer 3:15p-4p`, and roster_import splits them out. Where they are
    # genuinely absent they stay NULL, because inventing an end_time is worse
    # than leaving it empty: R2 compares it against the child's dismissal time,
    # and a wrong one routes a child to a care room the parent is not standing
    # in. NULL is what lets the board warn instead.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS class_sessions (
            id SERIAL PRIMARY KEY,
            name TEXT NOT NULL,
            day_of_week TEXT NOT NULL CHECK (day_of_week IN
                ('Monday','Tuesday','Wednesday','Thursday','Friday')),
            start_time TIME,
            end_time TIME,
            location TEXT,
            capacity INTEGER,
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT class_sessions_time_order_check CHECK (
                start_time IS NULL OR end_time IS NULL OR end_time > start_time
            ),
            CONSTRAINT class_sessions_capacity_check CHECK (
                capacity IS NULL OR capacity > 0
            )
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_class_sessions_day
            ON class_sessions (day_of_week) WHERE active
    """)

    # Its per-organization unique lives with the staff_assignments ones, below
    # ensure_tenancy_schema, because it needs the organization_id column that
    # only exists once that has run.

    # Which child is in which class. A child may be in several classes on the
    # same weekday — two rows pointing at two class_sessions that both say
    # 'Monday' — which is the case chaining exists for. The weekday is not
    # repeated here: it lives on the class, so the two cannot drift apart.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS class_enrollments (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            class_session_id INTEGER NOT NULL
                REFERENCES class_sessions(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE (child_id, class_session_id)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_class_enrollments_session
            ON class_enrollments (class_session_id)
    """)

    # Who is in each class and each care room (sql/37). One row is one person in
    # one place at one time, not a slot with a list, so the counselor view can
    # select WHERE counselor_id = me and get a day.
    #
    # The target is (room_id, time_block), NOT care_assignment_rules.id. R7 says
    # the grade split "varies with headcount" and §6.3 exists so she can move it;
    # hanging staff off the rule would delete Katelyn from the Gym every time a
    # grade range was edited. The range decides which children arrive, the
    # assignment decides who receives them.
    #
    # day_of_week is the weekly template of R8, assignment_date the call-out
    # override, and exactly one is set — a date already knows its weekday, and a
    # second copy of it is how a row contradicts itself. `status = 'removed'`
    # is what lets one person be pulled from a block for one day without
    # touching the two colleagues the template put there with them.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS staff_assignments (
            id SERIAL PRIMARY KEY,
            counselor_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            day_of_week TEXT CHECK (day_of_week IS NULL OR day_of_week IN
                ('Monday','Tuesday','Wednesday','Thursday','Friday')),
            assignment_date DATE,
            class_session_id INTEGER
                REFERENCES class_sessions(id) ON DELETE CASCADE,
            room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
            time_block TEXT CHECK (time_block IS NULL OR time_block IN
                ('3-4','4-5','5-6')),
            status TEXT NOT NULL DEFAULT 'assigned'
                CHECK (status IN ('assigned','removed')),
            created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT staff_assignments_when_check CHECK (
                (day_of_week IS NOT NULL) <> (assignment_date IS NOT NULL)),
            CONSTRAINT staff_assignments_target_check CHECK (
                (class_session_id IS NOT NULL) <> (room_id IS NOT NULL)),
            CONSTRAINT staff_assignments_room_block_check CHECK (
                room_id IS NULL OR time_block IS NOT NULL),
            CONSTRAINT staff_assignments_class_block_check CHECK (
                class_session_id IS NULL OR time_block IS NULL),
            CONSTRAINT staff_assignments_removed_check CHECK (
                status = 'assigned' OR assignment_date IS NOT NULL)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_staff_assignments_day
            ON staff_assignments (day_of_week) WHERE day_of_week IS NOT NULL
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_staff_assignments_date
            ON staff_assignments (assignment_date)
            WHERE assignment_date IS NOT NULL
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_staff_assignments_counselor
            ON staff_assignments (counselor_id)
    """)

    # The bus as a third target (sql/57). A route, like a class, is one thing
    # for the whole afternoon — never a time_block — so it gets the same
    # class_block_check shape rather than being folded into it, which is what
    # keeps the two targets distinguishable by which check fired.
    cur.execute("ALTER TABLE staff_assignments ADD COLUMN IF NOT EXISTS school_id "
                "INTEGER REFERENCES schools(id) ON DELETE CASCADE")
    cur.execute("ALTER TABLE staff_assignments "
                "DROP CONSTRAINT IF EXISTS staff_assignments_target_check")
    _add_check(cur, 'staff_assignments', 'staff_assignments_target_check',
               'num_nonnulls(class_session_id, room_id, school_id) = 1')
    _add_check(cur, 'staff_assignments', 'staff_assignments_school_block_check',
               'school_id IS NULL OR time_block IS NULL')

    # One row = "on this date, in this block, a counselor confirmed this child"
    # (sql/47). The §3.9 AttendanceEvent of the spec, narrowed to the two kinds
    # the My day screen produces.
    #
    # NOT attendance_records: that one is one row per child per DAY, written at
    # a school gate, and it is what the arrival board and a parent's absence
    # speak to. An afternoon asks the same question again in every block, and a
    # chained child is legitimately confirmed twice for two different reasons
    # (R3) — in a day-grained table the second confirmation overwrites the
    # first.
    #
    # No status column: 'here' would be its only value, since "absent" already
    # lives in `absences` and "not answered yet" is the absence of a row rather
    # than an answer. Un-confirming is a DELETE.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS block_checks (
            id SERIAL PRIMARY KEY,
            child_id INTEGER NOT NULL REFERENCES children(id) ON DELETE CASCADE,
            check_date DATE NOT NULL,
            class_session_id INTEGER
                REFERENCES class_sessions(id) ON DELETE CASCADE,
            room_id INTEGER REFERENCES rooms(id) ON DELETE CASCADE,
            time_block TEXT CHECK (time_block IS NULL OR time_block IN
                ('3-4','4-5','5-6')),
            marked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT block_checks_target_check CHECK (
                (class_session_id IS NOT NULL) <> (room_id IS NOT NULL)),
            CONSTRAINT block_checks_room_block_check CHECK (
                room_id IS NULL OR time_block IS NOT NULL),
            CONSTRAINT block_checks_class_block_check CHECK (
                class_session_id IS NULL OR time_block IS NULL)
        )
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_block_checks_date
            ON block_checks (check_date)
    """)
    cur.execute("""
        CREATE INDEX IF NOT EXISTS idx_block_checks_child
            ON block_checks (child_id)
    """)

    # The bus as a third confirmation target (sql/57), same shape as its
    # staff_assignments counterpart above.
    cur.execute("ALTER TABLE block_checks ADD COLUMN IF NOT EXISTS school_id "
                "INTEGER REFERENCES schools(id) ON DELETE CASCADE")
    cur.execute("ALTER TABLE block_checks "
                "DROP CONSTRAINT IF EXISTS block_checks_target_check")
    _add_check(cur, 'block_checks', 'block_checks_target_check',
               'num_nonnulls(class_session_id, room_id, school_id) = 1')
    _add_check(cur, 'block_checks', 'block_checks_school_block_check',
               'school_id IS NULL OR time_block IS NULL')

    # An upload parses into rows here and writes nothing to children until an
    # admin confirms, so the numbers they approved and the numbers that commit
    # come from one parse rather than two. roster_import_rows.parsed is a second
    # copy of dates of birth, allergies and phone numbers with its own lifetime;
    # the importer prunes old batches on every upload, and that retention is a
    # privacy control rather than housekeeping.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS roster_import_batches (
            id SERIAL PRIMARY KEY,
            filename TEXT NOT NULL,
            file_sha256 TEXT,
            uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            status TEXT NOT NULL DEFAULT 'preview'
                CHECK (status IN ('preview','committed','discarded','failed')),
            committed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
            committed_at TIMESTAMP,
            totals JSONB NOT NULL DEFAULT '{}'::jsonb,
            error TEXT
        )
    """)

    # source_row is the row number in the spreadsheet the admin still has open,
    # so "row 143 has no school" is something they can act on.
    cur.execute("""
        CREATE TABLE IF NOT EXISTS roster_import_rows (
            id SERIAL PRIMARY KEY,
            batch_id INTEGER NOT NULL REFERENCES roster_import_batches(id) ON DELETE CASCADE,
            source_sheet TEXT NOT NULL,
            source_row INTEGER NOT NULL,
            action TEXT NOT NULL CHECK (action IN
                ('create','update','unchanged','withdraw','skip','blocked')),
            match_child_id INTEGER REFERENCES children(id) ON DELETE SET NULL,
            child_name TEXT,
            school_raw TEXT,
            grade_raw TEXT,
            parsed JSONB NOT NULL DEFAULT '{}'::jsonb,
            changes JSONB NOT NULL DEFAULT '[]'::jsonb,
            notices JSONB NOT NULL DEFAULT '[]'::jsonb,
            applied_at TIMESTAMP,
            UNIQUE(batch_id, source_sheet, source_row)
        )
    """)

    # Performance indexes for common query patterns
    cur.execute("CREATE INDEX IF NOT EXISTS idx_children_parent_id ON children(parent_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_children_school_id ON children(school_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_children_active ON children(active)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_registrations_child_id ON registrations(child_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_absences_child_id ON absences(child_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_absences_absence_date ON absences(absence_date)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_recurring_absences_child ON recurring_absences(child_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_recurring_absences_dow ON recurring_absences(day_of_week)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_absence_exceptions_child ON absence_exceptions(child_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_absence_exceptions_date ON absence_exceptions(exception_date)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_attendance_records_date ON attendance_records(attendance_date)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_attendance_records_child_id ON attendance_records(child_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_users_role ON users(role)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_counselor_schools_counselor_id ON counselor_schools(counselor_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_activity_roster_activity_id ON activity_roster(activity_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_activity_roster_assigned ON activity_roster(assigned_counselor_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_activity_completions_counselor_date ON activity_completions(counselor_id, completion_date)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_parent_notifications_parent_id ON parent_notifications(parent_id)")
    # Partial unique: counselor cannot have two live (pending/approved) requests for the same day.
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_counselor_time_off_active
            ON counselor_time_off(counselor_id, off_date)
            WHERE status IN ('pending','approved')
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_counselor_time_off_status_date ON counselor_time_off(status, off_date)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_counselor_time_off_counselor ON counselor_time_off(counselor_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_roster_overrides_date_counselor ON activity_roster_overrides(override_date, assigned_counselor_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_roster_overrides_source_time_off ON activity_roster_overrides(source_time_off_id)")

    try:
        from server import bulk_invites
    except ImportError:
        import bulk_invites
    bulk_invites.ensure_schema(cur)

    # Tenancy has to land after every CREATE TABLE (it alters all of them) and
    # before the admin is seeded, since that admin needs an organization.
    tenancy.ensure_tenancy_schema(cur)

    # staff_assignments' uniques, which have to be here rather than in
    # PER_ORG_UNIQUES and rather than in sql/37.
    #
    # Not PER_ORG_UNIQUES: that tuple is rewritten as a plain
    # `UNIQUE (organization_id, <cols>)` with no NULLS NOT DISTINCT, and under
    # Postgres' default semantics two rows differing only where one holds NULL
    # do not collide. Half of these columns are nullable by design, so such a
    # constraint would dedupe nothing while looking like it did.
    #
    # Not sql/37 either: they include organization_id, which only exists once
    # ensure_tenancy_schema above has added it.
    #
    # One index per kind of target. The nullable template/date pair is made total
    # with COALESCE sentinels rather than merged into one string: casting a DATE
    # to text is not IMMUTABLE (it reads DateStyle), so Postgres refuses it in an
    # index expression, and to_char is only STABLE. A bare date literal is a
    # constant, so this form is accepted.
    #
    # Exactly one of the two is set — the CHECK guarantees it — so the sentinels
    # can never be mistaken for real values. It also means an 'assigned' and a
    # 'removed' row for the same person, slot and date cannot coexist, which is
    # right: that pair says nothing.
    for name, target, extra in (
        ('class_unique', 'class_session_id', ''),
        ('room_unique', 'room_id', 'time_block,'),
        ('school_unique', 'school_id', ''),
    ):
        cur.execute(f"""
            CREATE UNIQUE INDEX IF NOT EXISTS staff_assignments_{name}
                ON staff_assignments (
                    organization_id, counselor_id, {target}, {extra}
                    COALESCE(day_of_week, ''),
                    COALESCE(assignment_date, DATE '0001-01-01'))
             WHERE {target} IS NOT NULL
        """)

    # block_checks' uniques, here for exactly the reasons above: they carry
    # organization_id, and PER_ORG_UNIQUES would rebuild them without
    # NULLS NOT DISTINCT over columns that are nullable by design — so the
    # ON CONFLICT the write path rests on would match nothing and every tap
    # would insert a duplicate row.
    #
    # No COALESCE sentinels needed here: unlike staff_assignments there is no
    # nullable template/date pair. check_date is NOT NULL, and time_block is
    # only ever NULL on the class side, which its own index excludes.
    for name, cols in (
        ('class_unique', 'class_session_id'),
        ('room_unique', 'room_id, time_block'),
        ('school_unique', 'school_id'),
    ):
        target = cols.split(',')[0]
        cur.execute(f"""
            CREATE UNIQUE INDEX IF NOT EXISTS block_checks_{name}
                ON block_checks (organization_id, child_id, check_date, {cols})
             WHERE {target} IS NOT NULL
        """)

    # A class is identified by (organization, name, weekday, start time), and
    # the start time is not optional in that list: `HW Club 3p-4p` and
    # `HW Club 4p-5p` both run on Tuesday. Same name, same day, two classes,
    # each with its own room, counselor and roster. Keying on name and day alone
    # — which is what UNIQUE (name, day_of_week) did, and what PER_ORG_UNIQUES
    # rebuilt per organization — folds them into one and loses one of the two
    # rosters. Heather's spring roster has eight such pairs.
    #
    # An index rather than a constraint, and COALESCE rather than the bare
    # column, for the same reason as the two above: a NULL in a unique
    # constraint is distinct from every other NULL, so two hand-added rows with
    # no hours yet would both be allowed. Midnight is not an after-school hour,
    # so the sentinel cannot collide with a real class.
    #
    # lower(name) closes a gap that predates this: roster_staging looked classes
    # up with lower(name) while the constraint was case-sensitive, so `Chess`
    # and `CHESS` could both exist and the lookup found whichever came first.
    cur.execute("ALTER TABLE class_sessions "
                "DROP CONSTRAINT IF EXISTS class_sessions_name_day_of_week_key")
    cur.execute("ALTER TABLE class_sessions "
                "DROP CONSTRAINT IF EXISTS class_sessions_org_unique")
    cur.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS class_sessions_org_unique
            ON class_sessions (organization_id, lower(name), day_of_week,
                               COALESCE(start_time, TIME '00:00'))
    """)

    # init_db() and the seed script run outside any request, so nothing has
    # pinned an organization yet. Pin this standalone connection, and record
    # the id so pooled connections opened by scripts resolve to it too.
    cur.execute("SELECT id FROM organizations ORDER BY id LIMIT 1")
    _org = cur.fetchone()
    _org_id = _org['id'] if isinstance(_org, dict) else _org[0]
    tenancy.set_current_organization(cur, _org_id)
    set_script_organization(_org_id)

    # Create default admin account (uses env vars for email and password, never hardcoded)
    import bcrypt
    admin_email = os.environ.get('ADMIN_EMAIL')
    cur.execute("SELECT id FROM users WHERE role = 'admin'")
    existing = cur.fetchone()
    if not existing:
        if not admin_email:
            raise RuntimeError("ADMIN_EMAIL environment variable is required to seed the initial admin account.")
        admin_pw = os.environ.get('ADMIN_INITIAL_PASSWORD', '')
        if not admin_pw:
            import secrets
            admin_pw = secrets.token_urlsafe(16)
            print(f"[SECURITY] Generated initial admin password. Set ADMIN_INITIAL_PASSWORD env var for production.")
        pw_hash = bcrypt.hashpw(admin_pw.encode(), bcrypt.gensalt(rounds=12)).decode()
        # An admin always belongs to an organization; the first one created by
        # ensure_tenancy_schema owns this seeded account.
        cur.execute("SELECT id FROM organizations ORDER BY id LIMIT 1")
        org_row = cur.fetchone()
        org_id = org_row['id'] if isinstance(org_row, dict) else org_row[0]
        cur.execute(
            "INSERT INTO users (email, password_hash, role, name, organization_id) "
            "VALUES (%s, %s, 'admin', %s, %s)",
            (admin_email, pw_hash, 'Kikar Afterschool Administrator', org_id)
        )

    # Seed the Kikar superadmin, which sits above every organization.
    # SUPERADMIN_EMAIL is optional: without it the platform simply has no
    # superadmin yet, which is safer than inventing one.
    superadmin_email = os.environ.get('SUPERADMIN_EMAIL')
    if superadmin_email:
        cur.execute("SELECT id FROM users WHERE role = 'superadmin'")
        if not cur.fetchone():
            sa_pw = os.environ.get('SUPERADMIN_INITIAL_PASSWORD', '')
            if not sa_pw:
                import secrets
                sa_pw = secrets.token_urlsafe(16)
                print("[SECURITY] Generated initial superadmin password. "
                      "Set SUPERADMIN_INITIAL_PASSWORD to control it.")
            sa_hash = bcrypt.hashpw(sa_pw.encode(), bcrypt.gensalt(rounds=12)).decode()
            cur.execute(
                "INSERT INTO users (email, password_hash, role, name, organization_id) "
                "VALUES (%s, %s, 'superadmin', %s, NULL)",
                (superadmin_email, sa_hash, 'Kikar Platform Admin')
            )

    # Infer division_type for any school still at the default 'none' based on
    # the release_group values of its children. Idempotent: only touches rows
    # still at 'none'.
    cur.execute("""
        UPDATE schools SET division_type = 'torah'
        WHERE division_type = 'none'
          AND id IN (SELECT DISTINCT school_id FROM children WHERE release_group = 'Torah')
    """)
    cur.execute("""
        UPDATE schools SET division_type = 'grade'
        WHERE division_type = 'none'
          AND id IN (SELECT DISTINCT school_id FROM children WHERE release_group IN ('K-1st','2-5th'))
    """)
    # Known-school override: Ben Gamla is torah-split regardless of any dirty
    # data that may have infected the inference above.
    cur.execute("UPDATE schools SET division_type = 'torah' WHERE name ILIKE %s", ('%Ben Gamla%',))

    # Normalize children.release_group against the school's division_type.
    # Anything that doesn't match (e.g. a Ben Gamla child stamped 'K-1st') is
    # coerced to NULL, which the counselor UI treats as "Regular".
    cur.execute("""
        UPDATE children SET release_group = NULL
        WHERE id IN (
            SELECT c.id FROM children c JOIN schools s ON c.school_id = s.id
            WHERE c.release_group IS NOT NULL
              AND (
                   s.division_type = 'none'
                OR (s.division_type = 'torah' AND c.release_group <> 'Torah')
                OR (s.division_type = 'grade' AND c.release_group NOT IN ('K-1st','2-5th'))
              )
        )
    """)

    # Self-heal: relax six audit FKs to ON DELETE SET NULL so admin can delete a
    # counselor/parent without hitting FK violations. Pre-existing prod DBs
    # were created with the NOT NULL + RESTRICT default; this idempotently
    # brings them in line with the current CREATE TABLE definitions above.
    # Mirrors sql/12_fix_user_delete_fk_cascade.sql.
    for table, col, drop_not_null in [
        ('absences',             'marked_by',    True),
        ('recurring_absences',   'marked_by',    True),
        ('absence_exceptions',   'marked_by',    True),
        ('attendance_records',   'submitted_by', True),
        ('parent_notifications', 'sent_by',      True),
        ('calendar_events',      'created_by',   False),
    ]:
        cur.execute(f"""
            DO $$
            DECLARE c_name text;
            BEGIN
                {f'ALTER TABLE public.{table} ALTER COLUMN {col} DROP NOT NULL;' if drop_not_null else ''}
                SELECT conname INTO c_name FROM pg_constraint
                    WHERE conrelid = 'public.{table}'::regclass
                      AND contype = 'f'
                      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute
                                          WHERE attrelid='public.{table}'::regclass AND attname='{col}')]
                      AND (confdeltype <> 'n' OR conname <> '{table}_{col}_fkey');
                IF c_name IS NOT NULL THEN
                    EXECUTE format('ALTER TABLE public.{table} DROP CONSTRAINT %I', c_name);
                END IF;
                IF NOT EXISTS (SELECT 1 FROM pg_constraint
                               WHERE conrelid='public.{table}'::regclass
                                 AND conname='{table}_{col}_fkey') THEN
                    ALTER TABLE public.{table}
                        ADD CONSTRAINT {table}_{col}_fkey
                        FOREIGN KEY ({col}) REFERENCES public.users(id) ON DELETE SET NULL;
                END IF;
            END $$;
        """)

    conn.commit()
    conn.close()
    # Name the host rather than assuming Supabase. The same line prints during
    # local development, and a boot log that claims production while pointing at
    # localhost is how you end up trusting the wrong environment.
    from urllib.parse import urlsplit
    host = urlsplit(os.environ.get('ADMIN_DATABASE_URL') or DATABASE_URL or '').hostname
    print(f"Database initialized on {host or 'unknown host'}")
