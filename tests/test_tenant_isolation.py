"""Tenant isolation tests.

These check the property everything else depends on: that one JCC can never
read or write another's rows. They talk to the database directly as the
application role, because that is the layer the guarantee actually lives in —
application scoping can be bypassed by a missing WHERE, RLS cannot.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/jclub \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/jclub \
    python3 tests/test_tenant_isolation.py
"""

import os
import sys
from contextlib import contextmanager

import psycopg2
import psycopg2.extensions
import psycopg2.extras

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import tenancy  # noqa: E402

APP_URL = os.environ.get('DATABASE_URL', '')
OWNER_URL = os.environ.get('ADMIN_DATABASE_URL', APP_URL)

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected}, got {actual}")
    if not ok:
        failures.append(label)


def pin(cur, org_id, superadmin=False):
    cur.execute(
        "SELECT set_config('app.organization_id', %s, false),"
        "       set_config('app.is_superadmin', %s, false)",
        ('' if org_id is None else str(org_id), 'on' if superadmin else 'off'),
    )


@contextmanager
def superadmin(cur):
    """A narrow window for the setup that runs above every organization.

    Creating one is a superadmin act: org_self carries
    WITH CHECK (is_superadmin = 'on'), so being pinned to your own
    organization is not enough to write the row — and FORCE ROW LEVEL SECURITY
    means the table owner is subject to that too.

    The tight scope is the point. A connection left superadmin satisfies every
    policy in this file, and the whole test would pass with RLS doing nothing.
    Closing in a finally makes that state impossible to leave open by accident.
    """
    pin(cur, None, superadmin=True)
    try:
        yield
    finally:
        pin(cur, None)


def scalar(cur, sql, params=()):
    cur.execute(sql, params)
    row = cur.fetchone()
    return None if row is None else list(row.values())[0]


def main() -> int:
    owner = psycopg2.connect(OWNER_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    owner.autocommit = True
    oc = owner.cursor()

    # A superuser bypasses row level security unconditionally — that is what
    # the word means in Postgres, not a defect in these policies. Production's
    # ADMIN_DATABASE_URL points at a plain table owner, so the behavioural
    # probes below are meaningful there; against a superuser fixture they can
    # only ever fail, and a test that cries wolf every run is one nobody reads.
    #
    # So the guarantee is asserted structurally instead, on every table, which
    # holds from any connection: FORCE is precisely what stops a table's owner
    # skipping its own policies, and in a managed Postgres the application
    # frequently IS the owner.
    owner_is_superuser = scalar(
        oc, "SELECT rolsuper FROM pg_roles WHERE rolname = current_user"
    )

    forced = scalar(oc, """
        SELECT count(*) FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relkind = 'r'
           AND c.relname = ANY(%s)
           AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
    """, (list(tenancy.TENANT_TABLES) + ['organizations', 'organization_deletions'],))
    check("every tenant table forces RLS on its own owner", forced, 0)

    if owner_is_superuser:
        print()
        print("  NOTE: ADMIN_DATABASE_URL is a superuser, which bypasses RLS by")
        print("  definition. The owner-path probes below are skipped; the FORCE")
        print("  check above is the guarantee they would have demonstrated.")
        print("  Production must NOT point ADMIN_DATABASE_URL at a superuser —")
        print("  run this against the real owner role before trusting a deploy.")
        print()
    else:
        check(
            "owner role is subject to RLS too",
            scalar(oc,
                   "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user"),
            False,
        )

    # Two organizations, each with one school of its own.
    with superadmin(oc):
        oc.execute("""
            INSERT INTO organizations (slug, name) VALUES ('t-alpha', 'Alpha JCC')
            ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id
        """)
        alpha = oc.fetchone()['id']
        oc.execute("""
            INSERT INTO organizations (slug, name) VALUES ('t-beta', 'Beta JCC')
            ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id
        """)
        beta = oc.fetchone()['id']

    # Those two INSERTs succeeded because of the window, not because of the
    # role. The proof is that the same statement outside it is refused — which
    # also confirms the window shut, so nothing below is running with a
    # connection that satisfies every policy in the file.
    #
    # Its own slug, and no ON CONFLICT: against an existing row the DO UPDATE
    # would be an UPDATE returning no rows rather than an error, and this would
    # quietly be measuring something else.
    if not owner_is_superuser:
        try:
            oc.execute(
                "INSERT INTO organizations (slug, name) VALUES ('t-probe', 'Probe JCC')"
            )
            check("creating an organization outside the window is refused",
                  "inserted", "refused")
        except psycopg2.Error:
            check("creating an organization outside the window is refused",
                  "refused", "refused")
    else:
        # The same proof, through a role that RLS actually applies to. It shows
        # the window is what granted the writes above, not the connection.
        probe = psycopg2.connect(APP_URL,
                                 cursor_factory=psycopg2.extras.RealDictCursor)
        probe.autocommit = True
        pc = probe.cursor()
        pin(pc, None)
        try:
            pc.execute(
                "INSERT INTO organizations (slug, name) VALUES ('t-probe', 'Probe JCC')"
            )
            check("creating an organization outside the window is refused",
                  "inserted", "refused")
        except psycopg2.Error:
            check("creating an organization outside the window is refused",
                  "refused", "refused")
        probe.close()

    for org, school in ((alpha, 'Alpha School'), (beta, 'Beta School')):
        pin(oc, org)
        oc.execute(
            "INSERT INTO schools (name) VALUES (%s) ON CONFLICT DO NOTHING", (school,)
        )

    app = psycopg2.connect(APP_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    app.autocommit = True
    ac = app.cursor()

    # The policies are inert unless the connected role is subject to them.
    bypasses = scalar(
        ac, "SELECT rolbypassrls FROM pg_roles WHERE rolname = current_user"
    )
    check("application role is subject to RLS", bypasses, False)

    pin(ac, alpha)
    check(
        "alpha sees only its own school",
        scalar(ac, "SELECT count(*) FROM schools WHERE name LIKE '%%School'"),
        1,
    )
    check(
        "alpha cannot see beta's school",
        scalar(ac, "SELECT count(*) FROM schools WHERE name = 'Beta School'"),
        0,
    )

    pin(ac, beta)
    check(
        "beta cannot see alpha's school",
        scalar(ac, "SELECT count(*) FROM schools WHERE name = 'Alpha School'"),
        0,
    )

    # An unauthenticated request pins nothing. Reads must return nothing rather
    # than everything.
    pin(ac, None)
    check(
        "with no organization pinned, nothing is visible",
        scalar(ac, "SELECT count(*) FROM schools"),
        0,
    )

    # ...and writes must fail rather than land in an arbitrary tenant.
    try:
        ac.execute("INSERT INTO schools (name) VALUES ('Orphan School')")
        check("write with no organization is rejected", "inserted", "rejected")
    except psycopg2.Error:
        check("write with no organization is rejected", "rejected", "rejected")

    # Writing into someone else's organization must be refused even when the
    # id is supplied explicitly — this is the WITH CHECK half of the policy.
    pin(ac, alpha)
    try:
        ac.execute(
            "INSERT INTO schools (name, organization_id) VALUES ('Smuggled', %s)",
            (beta,),
        )
        check("cross-tenant write is refused", "inserted", "refused")
    except psycopg2.Error:
        check("cross-tenant write is refused", "refused", "refused")

    # A superadmin is the deliberate exception.
    pin(ac, None, superadmin=True)
    check(
        "superadmin sees both organizations",
        scalar(
            ac,
            "SELECT count(*) FROM organizations WHERE slug IN ('t-alpha', 't-beta')",
        ),
        2,
    )

    # Sign-in has to work before any organization is known.
    check(
        "auth_lookup reaches users without an organization pinned",
        scalar(ac, "SELECT count(*) FROM auth_lookup('nobody@example.com')"),
        0,
    )

    # ── Photos: the boundary RLS does NOT draw ──────────────────────────────
    # Everything above is one JCC against another, which the policies handle.
    # Photos add a second boundary inside a single JCC: one family against
    # another. RLS lets any parent in an organization read that organization's
    # photo rows, so the only thing separating two families is the parent_id
    # join in the application query. That is what these checks pin down.
    pin(oc, alpha)
    oc.execute("SELECT id FROM schools WHERE name = 'Alpha School'")
    a_school = oc.fetchone()['id']

    parents = {}
    for tag in ('one', 'two'):
        oc.execute(
            "INSERT INTO users (email, password_hash, role, name, organization_id) "
            "VALUES (%s, 'x', 'parent', %s, %s) "
            "ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name RETURNING id",
            (f'photo-{tag}@example.com', f'Parent {tag}', alpha),
        )
        parents[tag] = oc.fetchone()['id']
        oc.execute(
            "INSERT INTO children (name, parent_id, school_id, organization_id) "
            "VALUES (%s, %s, %s, %s) RETURNING id",
            (f'Child {tag}', parents[tag], a_school, alpha),
        )
        parents[f'child_{tag}'] = oc.fetchone()['id']

    # One photo, tagged only with parent one's child.
    oc.execute(
        "INSERT INTO photos (storage_path, photo_date, organization_id) "
        "VALUES ('org-x/2026-08-02/test.jpg', '2026-08-02', %s) RETURNING id",
        (alpha,),
    )
    photo_id = oc.fetchone()['id']
    oc.execute(
        "INSERT INTO photo_tags (photo_id, child_id, organization_id) "
        "VALUES (%s, %s, %s)",
        (photo_id, parents['child_one'], alpha),
    )

    # This is the exact query parent_list_photos runs.
    visible_to = """
        SELECT count(DISTINCT p.id)
          FROM photos p
          JOIN photo_tags t ON t.photo_id = p.id
          JOIN children c ON c.id = t.child_id
         WHERE c.parent_id = %s
    """
    pin(ac, alpha)
    check(
        "the tagged child's parent sees the photo",
        scalar(ac, visible_to, (parents['one'],)),
        1,
    )
    check(
        "another family in the same JCC does not",
        scalar(ac, visible_to, (parents['two'],)),
        0,
    )

    # And the between-JCC boundary still holds for photos specifically.
    pin(ac, beta)
    check(
        "another JCC cannot see the photo at all",
        scalar(ac, "SELECT count(*) FROM photos WHERE id = %s", (photo_id,)),
        0,
    )

    pin(oc, alpha)
    oc.execute("DELETE FROM photos WHERE id = %s", (photo_id,))
    oc.execute(
        "DELETE FROM children WHERE id = ANY(%s)",
        ([parents['child_one'], parents['child_two']],),
    )
    oc.execute(
        "DELETE FROM users WHERE id = ANY(%s)",
        ([parents['one'], parents['two']],),
    )

    # The realtime bus is isolated by channel, not by filtering after receipt:
    # a worker listening for one organization is never handed another's events.
    import select as _select

    listener = psycopg2.connect(APP_URL)
    listener.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
    lc = listener.cursor()
    lc.execute(f"LISTEN kikar_org_{alpha}")

    ac.execute("SELECT pg_notify(%s, %s)", (f'kikar_org_{beta}', '{"t":"beta"}'))
    ac.execute("SELECT pg_notify(%s, %s)", (f'kikar_org_{alpha}', '{"t":"alpha"}'))

    received = []
    deadline = 3.0
    while deadline > 0 and not received:
        if _select.select([listener], [], [], 0.5) != ([], [], []):
            listener.poll()
            while listener.notifies:
                received.append(listener.notifies.pop(0).payload)
        deadline -= 0.5

    check("listener receives its own organization's event", '{"t":"alpha"}' in received, True)
    check("listener never receives another organization's event",
          any('beta' in r for r in received), False)
    listener.close()

    for org in (alpha, beta):
        pin(oc, org)
        oc.execute("DELETE FROM schools WHERE name IN ('Alpha School', 'Beta School')")

    # Dropping the organizations needs the window for the same reason creating
    # them did. Without it this ran pinned to beta — whatever the loop above
    # left set — so USING matched one row and t-alpha survived every run. The
    # ON CONFLICT in the setup was quietly covering for that.
    #
    # organization_id is ON DELETE CASCADE, so this also clears any row the
    # checks above left behind. t-probe is here for the case where the refusal
    # assertion fails and the row really was created.
    with superadmin(oc):
        oc.execute(
            "DELETE FROM organizations WHERE slug IN ('t-alpha', 't-beta', 't-probe')"
        )

    app.close()
    owner.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("All isolation checks passed.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
