"""Every endpoint added in this round, walked across a tenant boundary.

Six steps added a dozen routes and a table. Each one has its own test with a
cross-organization check in it, which proves each route in isolation and
proves nothing about the set: the failure mode is the route somebody adds
next, or the one whose scoping quietly stopped depending on RLS.

So this file is deliberately shaped as a sweep. Two organizations, both fully
populated with the same-looking data, and then every read and every write from
A aimed at B's rows. A leak here is a JCC seeing another JCC's children, which
is the one bug in this app that cannot be walked back.

It also checks the structural half, which no request can demonstrate: that
every table registered in TENANT_TABLES actually carries organization_id and
the org_isolation policy. A table added to that list but never migrated looks
fine until the first cross-tenant read.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_cross_tenant_api.py
"""

import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database, tenancy  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

ORG_TZ = 'America/New_York'
TODAY = datetime.now(ZoneInfo(ORG_TZ)).date()
TODAY_S = TODAY.isoformat()
DAY_NAME = TODAY.strftime('%A')

MODULES = '{"check_in_out": true, "secure_pickup": true, "daily_ops": true}'


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected!r}, got {actual!r}")
    if not ok:
        failures.append(label)


def owner_conn():
    conn = database._connect_with_retry(database.ADMIN_DATABASE_URL)
    conn.autocommit = True
    return conn


def pin(cur, org_id, superadmin=False):
    cur.execute(
        "SELECT set_config('app.organization_id', %s, false),"
        "       set_config('app.is_superadmin', %s, false)",
        ('' if org_id is None else str(org_id), 'on' if superadmin else 'off'),
    )


def token(org_id, role='admin', user_id='1'):
    with app.app_context():
        return create_access_token(
            identity=str(user_id),
            additional_claims={'role': role, 'org': org_id})


def build_org(cur, slug, name, prefix):
    """One organization with a school, a counselor, a parent and a child."""
    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, timezone, modules) "
        "VALUES (%s, %s, %s, %s::jsonb) "
        "ON CONFLICT (slug) DO UPDATE SET modules = EXCLUDED.modules RETURNING id",
        (slug, name, ORG_TZ, MODULES))
    org = cur.fetchone()['id']
    pin(cur, org)
    for table in ('counselor_school_changes', 'attendance_records', 'absences',
                  'counselor_schools', 'registrations', 'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))

    cur.execute("INSERT INTO schools (name) VALUES (%s) RETURNING id",
                (f'{prefix} School',))
    school = cur.fetchone()['id']

    def user(kind, role):
        cur.execute("INSERT INTO users (email, password_hash, role, name) "
                    "VALUES (%s, 'x', %s, %s) RETURNING id",
                    (f'{prefix.lower()}-{kind}@example.com', role,
                     f'{prefix} {kind.title()}'))
        return cur.fetchone()['id']

    counselor = user('counselor', 'counselor')
    parent = user('parent', 'parent')
    cur.execute("INSERT INTO children (name, parent_id, school_id) "
                "VALUES (%s, %s, %s) RETURNING id",
                (f'{prefix} Child', parent, school))
    child = cur.fetchone()['id']
    if DAY_NAME not in ('Saturday', 'Sunday'):
        cur.execute("INSERT INTO registrations (child_id, day_of_week) "
                    "VALUES (%s, %s)", (child, DAY_NAME))
    cur.execute("INSERT INTO counselor_schools (counselor_id, school_id) "
                "VALUES (%s, %s)", (counselor, school))
    return {'org': org, 'school': school, 'counselor': counselor,
            'parent': parent, 'child': child}


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    a = build_org(cur, 't-xt-a', 'Alpha JCC', 'Alpha')
    b = build_org(cur, 't-xt-b', 'Beta JCC', 'Beta')

    # A's admin, aimed at B's rows throughout.
    auth = {'Authorization': f'Bearer {token(a["org"])}'}
    b_auth = {'Authorization': f'Bearer {token(b["org"])}'}

    # ── The structural half ───────────────────────────────────────────────
    pin(cur, None, superadmin=True)
    cur.execute("""
        SELECT t.tbl FROM unnest(%s::text[]) AS t(tbl)
         WHERE NOT EXISTS (
             SELECT 1 FROM information_schema.columns c
              WHERE c.table_schema = 'public' AND c.table_name = t.tbl
                AND c.column_name = 'organization_id')
    """, (list(tenancy.TENANT_TABLES),))
    check('every registered tenant table has organization_id',
          [r['tbl'] for r in cur.fetchall()], [])

    cur.execute("""
        SELECT t.tbl FROM unnest(%s::text[]) AS t(tbl)
         WHERE NOT EXISTS (
             SELECT 1 FROM pg_policies p
              WHERE p.schemaname = 'public' AND p.tablename = t.tbl
                AND p.policyname = 'org_isolation')
    """, (list(tenancy.TENANT_TABLES),))
    check('and the org_isolation policy',
          [r['tbl'] for r in cur.fetchall()], [])

    # The table this round added, specifically.
    check('the assignment log is a tenant table',
          'counselor_school_changes' in tenancy.TENANT_TABLES, True)

    # ── Reads: A must not see B ───────────────────────────────────────────
    kids = client.get('/api/admin/children?active=all', headers=auth).get_json()
    check('the children list is only A\'s',
          [c['name'] for c in kids['children']], ['Alpha Child'])
    check("B's child cannot be opened by id",
          client.get(f'/api/admin/children/{b["child"]}',
                     headers=auth).status_code, 404)

    counselors = client.get('/api/admin/counselors', headers=auth).get_json()
    check('the counselor list is only A\'s',
          [c['name'] for c in counselors], ['Alpha Counselor'])

    parents = client.get('/api/admin/parents', headers=auth).get_json()
    check('the parent list is only A\'s',
          [p['name'] for p in parents], ['Alpha Parent'])

    schools = client.get('/api/admin/schools', headers=auth).get_json()
    check('the school list is only A\'s',
          [s['name'] for s in schools], ['Alpha School'])

    board = client.get('/api/admin/operations', headers=auth).get_json()
    check('the live board only counts A\'s schools',
          [s['school'] for s in board['schools']], ['Alpha School'])

    head = client.get('/api/attendance/headcount', headers=auth).get_json()
    check('the headcount only counts A\'s schools',
          [s['school'] for s in head['schools']], ['Alpha School'])

    stats = client.get('/api/admin/stats', headers=auth).get_json()
    check('the stats tiles count only A', stats['children'], 1)

    # ── Assignments, and their log ────────────────────────────────────────
    check("B's counselor has no assignments visible to A",
          client.get(f'/api/admin/counselors/{b["counselor"]}/schools',
                     headers=auth).status_code, 404)
    check("A cannot assign B's counselor to a school",
          client.post(
              f'/api/admin/counselors/{b["counselor"]}/schools/{a["school"]}',
              json={}, headers=auth).status_code, 404)
    check("A cannot assign its own counselor to B's school",
          client.post(
              f'/api/admin/counselors/{a["counselor"]}/schools/{b["school"]}',
              json={}, headers=auth).status_code, 404)
    check("A cannot mint a setup link for B's counselor",
          client.post(f'/api/admin/counselors/{b["counselor"]}/setup-link',
                      headers=auth).status_code, 404)

    # Make B write a log entry, then confirm A cannot read it.
    client.post(f'/api/admin/counselors/{b["counselor"]}/schools/{b["school"]}',
                json={}, headers=b_auth)
    log_a = client.get('/api/admin/counselor-assignments/log',
                       headers=auth).get_json()
    check("THE ASSIGNMENT LOG DOES NOT CROSS THE BOUNDARY",
          any(e['counselor_name'] == 'Beta Counselor' for e in log_a), False)
    log_b = client.get('/api/admin/counselor-assignments/log',
                       headers=b_auth).get_json()
    check("and B does see its own entry",
          any(e['counselor_name'] == 'Beta Counselor' for e in log_b), True)

    # ── Counselor writes ──────────────────────────────────────────────────
    a_counselor = {'Authorization':
                   f'Bearer {token(a["org"], "counselor", a["counselor"])}'}
    check("A's counselor sees only A's school on their roster",
          [s['school'] for s in
           client.get('/api/counselor/roster', headers=a_counselor).get_json()],
          ['Alpha School'])
    check("A's counselor cannot set a status on B's child",
          client.post('/api/counselor/child-status', headers=a_counselor,
                      json={'child_id': b['child'], 'status': 'not_found'}
                      ).status_code, 403)
    client.post('/api/counselor/attendance', headers=a_counselor,
                json={'date': TODAY_S,
                      'records': [{'child_id': b['child'], 'on_bus': True}]})
    pin(cur, None, superadmin=True)
    cur.execute("SELECT count(*) AS n FROM attendance_records WHERE child_id = %s",
                (b['child'],))
    check("AND CANNOT MARK B'S CHILD PRESENT", cur.fetchone()['n'], 0)

    # ── The child status write stays inside the tenant ────────────────────
    check("A's counselor can set a status on A's own child",
          client.post('/api/counselor/child-status', headers=a_counselor,
                      json={'child_id': a['child'], 'status': 'not_found'}
                      ).status_code, 200)
    board_b = client.get('/api/admin/operations', headers=b_auth).get_json()
    check("and it does not appear on B's board",
          sum(len(s['flagged']) for s in board_b['schools']), 0)
    board_a = client.get('/api/admin/operations', headers=auth).get_json()
    check("while A's board shows it",
          [f['name'] for s in board_a['schools'] for f in s['flagged']],
          ['Alpha Child'])

    # Cleanup
    for org in (a['org'], b['org']):
        pin(cur, org)
        for table in ('counselor_school_changes', 'attendance_records',
                      'absences', 'counselor_schools', 'registrations',
                      'children', 'schools'):
            cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM users WHERE organization_id = ANY(%s)",
                ([a['org'], b['org']],))
    cur.execute("DELETE FROM organizations WHERE id = ANY(%s)",
                ([a['org'], b['org']],))
    check('cleanup removes both test organizations', cur.rowcount, 2)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All cross-tenant API checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
