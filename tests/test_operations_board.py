"""Tests for the admin's afternoon board.

Counselors could mark a child `not_found` or `issue` from their phone and that
was visible nowhere else in the app — a director learned about a missing child
from a phone call. This board is where those land.

The properties here:

  * The four states partition `expected` exactly. "N still to collect" is the
    number an afternoon is run on, and it is computed as the remainder, so it
    stays right even for a status this code has not heard of yet.
  * A flagged child arrives by name, with the note and who reported it.
  * Each school shows who is covering it *today* — an expired cover does not
    put someone's name on a board.
  * No assignments anywhere is "every counselor", not "nobody assigned". They
    are opposites and used to look identical.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_operations_board.py
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
TODAY = datetime.now(ZoneInfo(ORG_TZ)).date()
TODAY_S = TODAY.isoformat()
YESTERDAY = (TODAY - timedelta(days=1)).isoformat()
LAST_WEEK = (TODAY - timedelta(days=7)).isoformat()
DAY_NAME = TODAY.strftime('%A')

MODULES = '{"check_in_out": true}'


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


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0
    if DAY_NAME in ('Saturday', 'Sunday'):
        # registrations only admit Monday–Friday, so nobody is expected and
        # every count below would be zero for reasons unrelated to the code.
        print(f'Today is {DAY_NAME}; the board has no weekday to show. Skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, timezone, modules) "
        "VALUES ('t-ops', 'Ops JCC', %s, %s::jsonb) "
        "ON CONFLICT (slug) DO UPDATE SET timezone = EXCLUDED.timezone, "
        "  modules = EXCLUDED.modules RETURNING id", (ORG_TZ, MODULES))
    org = cur.fetchone()['id']
    pin(cur, org)
    for table in ('attendance_records', 'absences', 'counselor_schools',
                  'registrations', 'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))

    schools = {}
    for name in ('Brown', 'Glover'):
        cur.execute("INSERT INTO schools (name) VALUES (%s) RETURNING id", (name,))
        schools[name] = cur.fetchone()['id']

    def add_user(email, name, role):
        cur.execute("INSERT INTO users (email, password_hash, role, name) "
                    "VALUES (%s, 'x', %s, %s) RETURNING id", (email, role, name))
        return cur.fetchone()['id']

    angelie = add_user('t-ops-a@example.com', 'Angelie Fischer', 'counselor')
    gianna = add_user('t-ops-g@example.com', 'Gianna Marino', 'counselor')
    expired = add_user('t-ops-x@example.com', 'Expired Cover', 'counselor')
    parent = add_user('t-ops-p@example.com', 'A Parent', 'parent')

    def add_child(name, school, scheduled=True):
        cur.execute("INSERT INTO children (name, parent_id, school_id) "
                    "VALUES (%s, %s, %s) RETURNING id",
                    (name, parent, schools[school]))
        cid = cur.fetchone()['id']
        if scheduled:
            cur.execute("INSERT INTO registrations (child_id, day_of_week) "
                        "VALUES (%s, %s)", (cid, DAY_NAME))
        return cid

    def mark(child_id, school, on_bus, status, note=None, released=False):
        cur.execute(
            "INSERT INTO attendance_records (child_id, school_id, "
            "  attendance_date, on_bus, status, status_at, status_by, "
            "  status_note, checked_out_at) "
            "VALUES (%s, %s, %s, %s, %s, NOW(), %s, %s, %s)",
            (child_id, schools[school], TODAY_S, on_bus, status, angelie, note,
             datetime.now() if released else None))

    # Brown: one in, one released, one not found, one issue, one nothing yet,
    # one called in absent, and one who does not come today at all.
    here = add_child('Here Child', 'Brown')
    left = add_child('Left Child', 'Brown')
    missing = add_child('Missing Child', 'Brown')
    trouble = add_child('Trouble Child', 'Brown')
    add_child('Untouched Child', 'Brown')
    away = add_child('Away Child', 'Brown')
    add_child('Other Day Child', 'Brown', scheduled=False)

    mark(here, 'Brown', 1, 'picked_up')
    mark(left, 'Brown', 1, 'checked_out', released=True)
    mark(missing, 'Brown', 0, 'not_found')
    mark(trouble, 'Brown', 0, 'issue', note='Wrong bus')
    cur.execute("INSERT INTO absences (child_id, absence_date) VALUES (%s, %s)",
                (away, TODAY_S))

    add_child('Glover Child', 'Glover')

    auth = {'Authorization': f'Bearer {token(org)}'}

    # ── Nobody assigned anywhere ──────────────────────────────────────────
    body = client.get('/api/admin/operations', headers=auth).get_json()
    check('with no assignments, everyone covers everything',
          body['every_counselor_covers_every_school'], True)

    # ── Assign, including one cover that has already expired ──────────────
    cur.execute("INSERT INTO counselor_schools (counselor_id, school_id) "
                "VALUES (%s, %s)", (angelie, schools['Brown']))
    cur.execute("INSERT INTO counselor_schools (counselor_id, school_id, "
                "  effective_from, effective_to) VALUES (%s, %s, %s, %s)",
                (gianna, schools['Brown'], TODAY_S, TODAY_S))
    cur.execute("INSERT INTO counselor_schools (counselor_id, school_id, "
                "  effective_from, effective_to) VALUES (%s, %s, %s, %s)",
                (expired, schools['Brown'], LAST_WEEK, YESTERDAY))

    body = client.get('/api/admin/operations', headers=auth).get_json()
    check('the date is echoed back', body['date'], TODAY_S)
    check('assignments exist now, so the fail-open flag drops',
          body['every_counselor_covers_every_school'], False)

    by_school = {s['school']: s for s in body['schools']}
    check('both schools appear', sorted(by_school), ['Brown', 'Glover'])

    brown = by_school['Brown']
    check('the permanent and the live cover are both shown',
          sorted(c['name'] for c in brown['counselors']),
          ['Angelie Fischer', 'Gianna Marino'])
    check('AN EXPIRED COVER DOES NOT PUT A NAME ON THE BOARD',
          any(c['name'] == 'Expired Cover' for c in brown['counselors']), False)
    check('and the temporary one is marked as such',
          {c['name']: c['permanent'] for c in brown['counselors']},
          {'Angelie Fischer': True, 'Gianna Marino': False})

    # ── The counts ────────────────────────────────────────────────────────
    # Expected = 6 scheduled: here, left, missing, trouble, untouched, away.
    # `away` is reported absent and never marked in, so it drops out.
    check('expected counts the scheduled minus the called-in absent',
          brown['expected'], 5)
    check('in the building', brown['in_building'], 1)
    check('picked up by a parent', brown['checked_out'], 1)
    check('problems is not_found plus issue', brown['problems'], 2)
    check('still out is the remainder', brown['waiting'], 1)
    check('the absent are reported separately', brown['absent'], 1)
    check('and so is the child who does not come today',
          brown['unscheduled'], 1)
    check('THE FOUR STATES PARTITION EXPECTED EXACTLY',
          brown['in_building'] + brown['checked_out'] + brown['problems']
          + brown['waiting'],
          brown['expected'])

    # ── The flagged children, by name ─────────────────────────────────────
    flags = {f['name']: f for f in brown['flagged']}
    check('THE FLAGGED CHILDREN ARRIVE BY NAME',
          sorted(flags), ['Missing Child', 'Trouble Child'])
    check('with their status', flags['Missing Child']['status'], 'not_found')
    check('with the note', flags['Trouble Child']['note'], 'Wrong bus')
    check('and who reported it',
          flags['Trouble Child']['reported_by'], 'Angelie Fischer')
    check('a school with nothing wrong carries no flags',
          by_school['Glover']['flagged'], [])

    # ── A flag clears when the child turns up ─────────────────────────────
    cur.execute("UPDATE attendance_records SET on_bus = 1, status = 'picked_up' "
                " WHERE child_id = %s AND attendance_date = %s",
                (missing, TODAY_S))
    body = client.get('/api/admin/operations', headers=auth).get_json()
    brown = {s['school']: s for s in body['schools']}['Brown']
    check('finding the child clears the flag',
          [f['name'] for f in brown['flagged']], ['Trouble Child'])
    check('and moves them into the building', brown['in_building'], 2)
    check('the four still partition expected',
          brown['in_building'] + brown['checked_out'] + brown['problems']
          + brown['waiting'],
          brown['expected'])

    # ── Roles and tenancy ─────────────────────────────────────────────────
    for role in ('counselor', 'parent'):
        check(f'a {role} cannot read the board',
              client.get('/api/admin/operations',
                         headers={'Authorization': f'Bearer {token(org, role)}'}
                         ).status_code, 403)
    check('a malformed date is rejected',
          client.get('/api/admin/operations?date=nope',
                     headers=auth).status_code, 400)

    # Turning the module off closes the route, as for the headcount it extends.
    pin(cur, None, superadmin=True)
    cur.execute("UPDATE organizations SET modules = '{}'::jsonb WHERE id = %s",
                (org,))
    pin(cur, org)
    check('the board is behind check_in_out',
          client.get('/api/admin/operations', headers=auth).status_code, 403)

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
    print('All operations board checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
