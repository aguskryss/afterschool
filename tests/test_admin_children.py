"""Tests for the admin children screen's two read endpoints.

These boot the real Flask app and call the routes through the test client, so
what is under test is the request as an admin's browser makes it — role guard,
tenant pin, SQL and serialization together. The alternative, asserting on a
copy of the query, drifts away from the handler the first time either changes.

The properties that matter here, in order:

  * A child's week survives the round trip with a *per-day* dismissal hour. The
    whole screen exists because those differ by day, and an aggregate that
    collapses them is the failure nobody would notice until pickup.
  * A NULL dismissal hour stays NULL. For every JCC except the one that runs
    dismissal times, a registrations row means "enrolled this weekday" and
    nothing more; rendering 6pm there would invent a fact.
  * A child enrolled on no day at all is still returned. Sixty of them came in
    with the roster, and they are invisible in every derived view by design —
    this screen is where an admin finds them.
  * One JCC cannot read another's children.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_admin_children.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

# A fixed Monday. Every status assertion below depends on the weekday, and a
# test that passes four days out of seven is worse than no test.
MONDAY = '2026-08-03'


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


def seed_org(cur, slug, name):
    """Create an organization. Writing the row needs a superadmin window:
    org_self carries WITH CHECK (is_superadmin = 'on') and FORCE ROW LEVEL
    SECURITY applies it to the owner too."""
    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, timezone) "
        "VALUES (%s, %s, 'America/New_York') "
        "ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        (slug, name),
    )
    org_id = cur.fetchone()['id']
    pin(cur, org_id)
    return org_id


def wipe(cur, org_id):
    for table in ('registrations', 'child_contacts', 'child_compliance',
                  'attendance_records', 'absences', 'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org_id,))
    cur.execute(
        "DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
        (org_id,),
    )


def add_school(cur, name):
    cur.execute("INSERT INTO schools (name) VALUES (%s) RETURNING id", (name,))
    return cur.fetchone()['id']


def add_parent(cur, email, name):
    cur.execute(
        "INSERT INTO users (email, password_hash, role, name) "
        "VALUES (%s, 'x', 'parent', %s) RETURNING id",
        (email, name),
    )
    return cur.fetchone()['id']


def add_child(cur, name, school_id, parent_id, days, first=None, last=None,
              grade_label=None, grade_num=None, active=1, allergies=None,
              contacts=(), withdrawn=None):
    cur.execute(
        "INSERT INTO children (name, parent_id, school_id, first_name, "
        "  last_name, grade_label, grade_num, allergies, active, "
        "  withdrawn_reason) "
        "VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING id",
        (name, parent_id, school_id, first, last, grade_label, grade_num,
         allergies, active, withdrawn),
    )
    child_id = cur.fetchone()['id']
    for day, hour in days:
        cur.execute(
            "INSERT INTO registrations (child_id, day_of_week, dismissal_time) "
            "VALUES (%s, %s, %s)",
            (child_id, day, hour),
        )
    for priority, cname, phone, email in contacts:
        cur.execute(
            "INSERT INTO child_contacts (child_id, priority, name, phone, email) "
            "VALUES (%s, %s, %s, %s, %s)",
            (child_id, priority, cname, phone, email),
        )
    return child_id


def token(org_id, role='admin'):
    with app.app_context():
        return create_access_token(
            identity='1', additional_claims={'role': role, 'org': org_id})


def seed():
    """Two organizations. The second exists only to be invisible from the first."""
    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    org_a = seed_org(cur, 't-children-a', 'Test JCC A')
    wipe(cur, org_a)
    brown = add_school(cur, 'Brown')
    glover = add_school(cur, 'Glover')
    cohen = add_parent(cur, 't-children-cohen@example.com', 'Dana Cohen')
    levy = add_parent(cur, 't-children-levy@example.com', 'Ruth Levy')
    stern = add_parent(cur, 't-children-stern@example.com', 'Ari Stern')

    ids = {
        # A different dismissal hour on three of four days — the shape the
        # screen was built for.
        'maya': add_child(
            cur, 'Maya Cohen', brown, cohen,
            [('Monday', 3), ('Wednesday', 4), ('Thursday', 3), ('Friday', 5)],
            first='Maya', last='Cohen', grade_label='K', grade_num=0,
            allergies='Tree Nut (EpiPen)',
            contacts=[(1, 'Dana Cohen', '555-0100', 'cohen@example.com'),
                      (2, 'Eli Cohen', '555-0101', 'eli@example.com')]),
        # A sibling: same parent, different school and grade.
        'noah': add_child(cur, 'Noah Cohen', glover, cohen,
                          [('Monday', 5), ('Tuesday', 5)],
                          first='Noah', last='Cohen', grade_label='3', grade_num=3),
        # Enrolled on no day at all.
        'tali': add_child(cur, 'Tali Levy', brown, levy, [],
                          first='Tali', last='Levy', grade_label='1', grade_num=1),
        # Withdrawn — the `No Longer` sheet.
        'sam': add_child(cur, 'Sam Gone', brown, levy, [('Monday', 4)],
                         first='Sam', last='Gone', grade_label='2', grade_num=2,
                         active=0, withdrawn='No Longer sheet'),
        # Registrations with no dismissal hour: every other JCC.
        'ben': add_child(cur, 'Ben Stern', glover, stern,
                         [('Monday', None), ('Tuesday', None)],
                         first='Ben', last='Stern', grade_label='4', grade_num=4),
        'dov': add_child(cur, 'Dov Stern', glover, stern,
                         [(d, 6) for d in ('Monday', 'Tuesday', 'Wednesday',
                                           'Thursday', 'Friday')],
                         first='Dov', last='Stern', grade_label='K', grade_num=0),
    }

    org_b = seed_org(cur, 't-children-b', 'Test JCC B')
    wipe(cur, org_b)
    other_school = add_school(cur, 'Somewhere Else')
    other_parent = add_parent(cur, 't-children-other@example.com', 'Other Parent')
    ids['other'] = add_child(cur, 'Invisible Child', other_school, other_parent,
                             [('Monday', 4)])

    cur.close()
    conn.close()
    return {'a': org_a, 'b': org_b}, {'Brown': brown, 'Glover': glover}, ids


def cleanup(orgs):
    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)
    for org_id in orgs.values():
        pin(cur, org_id)
        wipe(cur, org_id)
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM users WHERE organization_id = ANY(%s)",
                (list(orgs.values()),))
    cur.execute("DELETE FROM organizations WHERE id = ANY(%s)",
                (list(orgs.values()),))
    left = cur.rowcount
    cur.close()
    conn.close()
    return left


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    orgs, schools, ids = seed()
    app.config['TESTING'] = True
    client = app.test_client()
    auth = {'Authorization': f'Bearer {token(orgs["a"])}'}

    # ── The list ──────────────────────────────────────────────────────────
    r = client.get(f'/api/admin/children?active=all&date={MONDAY}', headers=auth)
    check('list returns 200', r.status_code, 200)
    body = r.get_json()
    check('weekday is resolved from the date', body['day'], 'Monday')
    check('every child is returned', len(body['children']), 6)
    check('rows are ordered by name', body['children'][0]['name'], 'Ben Stern')

    kids = {c['name']: c for c in body['children']}
    maya = kids['Maya Cohen']
    check('the enrolled days come back', len(maya['days']), 4)
    check('days are in weekday order, not alphabetical',
          [d['day'] for d in maya['days']],
          ['Monday', 'Wednesday', 'Thursday', 'Friday'])
    check('the dismissal hour is per day',
          [d['dismissal_time'] for d in maya['days']], [3, 4, 3, 5])
    check('both guardians are returned', len(maya['contacts']), 2)
    check('guardians are ordered by priority',
          [c['priority'] for c in maya['contacts']], [1, 2])
    check('allergies are carried', maya['allergies'], 'Tree Nut (EpiPen)')
    check('the school is joined', maya['school'], 'Brown')
    check("the grade keeps the roster's own spelling", maya['grade_label'], 'K')

    check('a child enrolled on no day is still returned',
          kids['Tali Levy']['days'], [])
    check('a NULL dismissal hour stays NULL and is never read as 6',
          [d['dismissal_time'] for d in kids['Ben Stern']['days']], [None, None])
    check('a child with no contacts row falls back to the parent account',
          kids['Ben Stern']['parent_name'], 'Ari Stern')
    check('the withdrawal reason is carried',
          kids['Sam Gone']['withdrawn_reason'], 'No Longer sheet')

    # ── Status, which is derived rather than stored ───────────────────────
    check('scheduled today reads as expected', maya['status'], 'expected')
    check('no enrolled day reads as not_scheduled',
          kids['Tali Levy']['status'], 'not_scheduled')
    check('a withdrawn child reads as inactive',
          kids['Sam Gone']['status'], 'inactive')

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)
    pin(cur, orgs['a'])
    cur.execute(
        "INSERT INTO attendance_records (child_id, school_id, attendance_date, "
        "  on_bus, checked_in_at) "
        "SELECT %s, school_id, %s, 1, NOW() FROM children WHERE id = %s",
        (ids['dov'], MONDAY, ids['dov']))
    cur.execute("INSERT INTO absences (child_id, absence_date) VALUES (%s, %s)",
                (ids['noah'], MONDAY))

    r = client.get(f'/api/admin/children?active=all&date={MONDAY}', headers=auth)
    kids = {c['name']: c for c in r.get_json()['children']}
    # `picked_up`, not `in_building`: the admin screen and the counselor's
    # screen name this state the same way now. Two words for one state is how
    # the meanings came apart in the first place.
    check('a checked-in child reads as picked_up',
          kids['Dov Stern']['status'], 'picked_up')
    check('timestamps serialize as UTC ISO with a trailing Z',
          kids['Dov Stern']['checked_in_at'].endswith('Z'), True)
    check('a child marked absent reads as absent',
          kids['Noah Cohen']['status'], 'absent')

    cur.execute("UPDATE attendance_records SET checked_out_at = NOW() "
                "WHERE child_id = %s AND attendance_date = %s",
                (ids['dov'], MONDAY))
    r = client.get(f'/api/admin/children?active=all&date={MONDAY}', headers=auth)
    kids = {c['name']: c for c in r.get_json()['children']}
    check('a released child reads as checked_out, not picked_up',
          kids['Dov Stern']['status'], 'checked_out')
    cur.close()
    conn.close()

    # ── Filters ───────────────────────────────────────────────────────────
    r = client.get(f'/api/admin/children?active=1&date={MONDAY}', headers=auth)
    check('the active filter drops the withdrawn child',
          len(r.get_json()['children']), 5)
    r = client.get(
        f'/api/admin/children?school_id={schools["Brown"]}&active=all&date={MONDAY}',
        headers=auth)
    check('the school filter',
          sorted(c['name'] for c in r.get_json()['children']),
          ['Maya Cohen', 'Sam Gone', 'Tali Levy'])
    r = client.get(f'/api/admin/children?day=Wednesday&active=all&date={MONDAY}',
                   headers=auth)
    check('the day filter matches enrolment, not the requested date',
          sorted(c['name'] for c in r.get_json()['children']),
          ['Dov Stern', 'Maya Cohen'])
    check('an unknown weekday is rejected rather than ignored',
          client.get('/api/admin/children?day=Caturday', headers=auth).status_code,
          400)
    check('a malformed date is rejected',
          client.get('/api/admin/children?date=03-08-2026', headers=auth).status_code,
          400)

    # ── The profile ───────────────────────────────────────────────────────
    r = client.get(f'/api/admin/children/{ids["maya"]}?date={MONDAY}', headers=auth)
    check('the profile returns 200', r.status_code, 200)
    detail = r.get_json()
    check('the profile carries the weekly schedule', len(detail['days']), 4)
    check('the profile carries both guardians', len(detail['contacts']), 2)
    check('the profile carries an attendance history',
          isinstance(detail['recent_attendance'], list), True)
    check('a child that does not exist is 404',
          client.get('/api/admin/children/999999', headers=auth).status_code, 404)

    # ── Roles ─────────────────────────────────────────────────────────────
    for role in ('parent', 'counselor', 'superadmin'):
        rr = client.get(
            '/api/admin/children',
            headers={'Authorization': f'Bearer {token(orgs["a"], role)}'})
        check(f'a {role} cannot list children', rr.status_code, 403)
    check('an unauthenticated request is rejected',
          client.get('/api/admin/children').status_code, 401)

    # ── Tenancy ───────────────────────────────────────────────────────────
    # The child in organization B is real and reachable by its own admin; the
    # point is that A's admin gets 404 rather than a row.
    b_auth = {'Authorization': f'Bearer {token(orgs["b"])}'}
    r = client.get(f'/api/admin/children?active=all&date={MONDAY}', headers=b_auth)
    check("B's admin sees only B's child",
          [c['name'] for c in r.get_json()['children']], ['Invisible Child'])
    r = client.get(f'/api/admin/children?active=all&date={MONDAY}', headers=auth)
    check("A's list never contains B's child",
          any(c['name'] == 'Invisible Child' for c in r.get_json()['children']),
          False)
    check("A's admin cannot open B's child by id",
          client.get(f'/api/admin/children/{ids["other"]}', headers=auth).status_code,
          404)

    check('cleanup removes both test organizations', cleanup(orgs), 2)

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All admin children checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
