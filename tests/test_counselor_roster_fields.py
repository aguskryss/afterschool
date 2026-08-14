"""Tests for what the counselor's roster tells them about each child.

A counselor standing at a school gate needs to know who they are looking for,
when that child goes home, and whether anything about them changes what to do.
The roster used to carry a name, a parent and a service type — none of which
answer any of those.

The properties here:

  * Grade and the dismissal hour come through, per child and per day.
  * A NULL dismissal hour stays NULL. For every JCC that does not run
    dismissal times, a registrations row means "enrolled this weekday" and
    nothing more.
  * Allergies come through. It is the one field that changes what a counselor
    does in the moment.
  * The absent half of the roster carries the same fields as the attending
    half. It used to carry fewer, from a second copy of the query that had
    quietly drifted.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_counselor_roster_fields.py
"""

import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

ORG_TZ = 'America/New_York'
# A fixed Monday, so the weekday the roster filters on is not the container's
# guess. See tests/test_counselor_assignments.py for the bug that taught us.
MONDAY = '2026-08-03'
TUESDAY = '2026-08-04'


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


def token(org_id, role, user_id='1'):
    with app.app_context():
        return create_access_token(
            identity=str(user_id),
            additional_claims={'role': role, 'org': org_id})


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, timezone) "
        "VALUES ('t-roster', 'Roster JCC', %s) "
        "ON CONFLICT (slug) DO UPDATE SET timezone = EXCLUDED.timezone RETURNING id",
        (ORG_TZ,))
    org = cur.fetchone()['id']
    pin(cur, org)
    for table in ('attendance_records', 'absences', 'counselor_schools',
                  'registrations', 'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))

    cur.execute("INSERT INTO schools (name) VALUES ('Brown') RETURNING id")
    brown = cur.fetchone()['id']

    def add_user(email, name, role):
        cur.execute("INSERT INTO users (email, password_hash, role, name) "
                    "VALUES (%s, 'x', %s, %s) RETURNING id", (email, role, name))
        return cur.fetchone()['id']

    counselor = add_user('t-roster-c@example.com', 'A Counselor', 'counselor')
    parent = add_user('t-roster-p@example.com', 'A Parent', 'parent')

    def add_child(name, grade_label, grade_num, days, allergies=None, notes=None):
        cur.execute(
            "INSERT INTO children (name, parent_id, school_id, grade_label, "
            "  grade_num, allergies, notes) "
            "VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id",
            (name, parent, brown, grade_label, grade_num, allergies, notes))
        cid = cur.fetchone()['id']
        for day, hour in days:
            cur.execute("INSERT INTO registrations (child_id, day_of_week, "
                        "  dismissal_time) VALUES (%s, %s, %s)", (cid, day, hour))
        return cid

    # Different hours on different days — the case the screen exists for.
    add_child('Maya Cohen', 'K', 0,
              [('Monday', 3), ('Tuesday', 5)], allergies='Tree Nut (EpiPen)')
    # No dismissal hour at all: every JCC that does not run them.
    add_child('Ben Stern', '4', 4, [('Monday', None)])
    # Reported absent, so they land in the other half of the payload.
    away = add_child('Away Child', '2', 2, [('Monday', 4)], notes='Sibling of Maya')
    cur.execute("INSERT INTO absences (child_id, absence_date) VALUES (%s, %s)",
                (away, MONDAY))

    cauth = {'Authorization': f'Bearer {token(org, "counselor", counselor)}'}

    def roster(date):
        r = client.get(f'/api/counselor/roster?date={date}', headers=cauth)
        return r.get_json()[0]

    # ── Monday ────────────────────────────────────────────────────────────
    mon = roster(MONDAY)
    attending = {c['name']: c for c in mon['attending']}
    check('the attending half has the two who are coming',
          sorted(attending), ['Ben Stern', 'Maya Cohen'])

    maya = attending['Maya Cohen']
    check('the grade comes through', maya['grade'], 'K')
    check('and its number, for sorting', maya['grade_num'], 0)
    check("Monday's dismissal hour comes through", maya['dismissal_time'], 3)
    check('allergies come through', maya['allergies'], 'Tree Nut (EpiPen)')

    check('A NULL DISMISSAL HOUR STAYS NULL, NEVER 6',
          attending['Ben Stern']['dismissal_time'], None)
    check('a child with no allergies says so rather than inventing one',
          attending['Ben Stern']['allergies'], None)

    # ── The same child, a different day ───────────────────────────────────
    tue = roster(TUESDAY)
    tue_maya = {c['name']: c for c in tue['attending']}['Maya Cohen']
    check('THE DISMISSAL HOUR IS PER DAY, NOT PER CHILD',
          tue_maya['dismissal_time'], 5)
    check('and the day it belongs to is echoed back', tue['day'], 'Tuesday')
    check("Tuesday drops the children who only come Monday",
          sorted(c['name'] for c in tue['attending']), ['Maya Cohen'])

    # ── The absent half carries the same fields ───────────────────────────
    check('the absent child is in the absent half',
          [c['name'] for c in mon['absent']], ['Away Child'])
    gone = mon['absent'][0]
    check('THE ABSENT HALF CARRIES THE SAME FIELDS AS THE ATTENDING ONE',
          sorted(gone), sorted(maya))
    check('including their grade', gone['grade'], '2')
    check('their dismissal hour', gone['dismissal_time'], 4)
    check('and the roster notes', gone['notes'], 'Sibling of Maya')

    # ── Still scoped to the counselor's schools ───────────────────────────
    cur.execute("INSERT INTO counselor_schools (counselor_id, school_id) "
                "VALUES (%s, %s)", (counselor, brown))
    check('an assigned counselor still sees their school',
          len(client.get(f'/api/counselor/roster?date={MONDAY}',
                         headers=cauth).get_json()), 1)

    cur.execute("INSERT INTO schools (name) VALUES ('Glover') RETURNING id")
    glover = cur.fetchone()['id']
    cur.execute("DELETE FROM counselor_schools WHERE counselor_id = %s", (counselor,))
    cur.execute("INSERT INTO counselor_schools (counselor_id, school_id) "
                "VALUES (%s, %s)", (counselor, glover))
    check('and does not see a school that is not theirs',
          [s['school'] for s in client.get(
              f'/api/counselor/roster?date={MONDAY}',
              headers=cauth).get_json()], ['Glover'])

    # Cleanup
    pin(cur, org)
    for table in ('attendance_records', 'absences', 'counselor_schools',
                  'registrations', 'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM users WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM organizations WHERE id = %s", (org,))
    check('cleanup removes the test organization', cur.rowcount, 1)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All counselor roster field checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
