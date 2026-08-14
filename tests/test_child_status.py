"""Tests for a child's status through the afternoon.

`on_bus` was one boolean doing four jobs: the counselor's tap at school, "is
this child here", the headcount's numerator, and — because a release sets it
to 1 — a child who left an hour ago. The screens disagreed about which it
meant, and on the any-date roster a released child was indistinguishable from
one still in the building.

The properties here, in the order they matter:

  * A signed release is not undone by a checkbox. Untapping a released child
    used to null checked_out_at, detaching a pickup_releases row — signature,
    authorized person, timestamp — from an attendance row that then read
    "never here".
  * `picked_up` and `checked_out` are different states, and the endpoint the
    counselor screens actually read returns both.
  * Applying the migration changes nothing. Rows written before the status
    column derive the same answer they always did, from on_bus and
    checked_out_at.
  * `checked_out` cannot be set except by a release with a signature (R6).

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_child_status.py
"""

import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app, derive_status  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

ORG_TZ = 'America/New_York'
# Built in the organization's zone, not the container's — see
# tests/test_counselor_assignments.py for the bug that taught us to.
TODAY = datetime.now(ZoneInfo(ORG_TZ)).strftime('%Y-%m-%d')

MODULES = '{"check_in_out": true, "secure_pickup": true}'


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
        "INSERT INTO organizations (slug, name, timezone, modules) "
        "VALUES ('t-status', 'Status JCC', %s, %s::jsonb) "
        "ON CONFLICT (slug) DO UPDATE SET timezone = EXCLUDED.timezone, "
        "  modules = EXCLUDED.modules RETURNING id", (ORG_TZ, MODULES))
    org = cur.fetchone()['id']
    pin(cur, org)
    for table in ('pickup_releases', 'authorized_pickup_people',
                  'attendance_records', 'counselor_schools', 'registrations',
                  'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))

    cur.execute("INSERT INTO schools (name) VALUES ('Brown') RETURNING id")
    brown = cur.fetchone()['id']

    def add_user(email, name, role):
        cur.execute("INSERT INTO users (email, password_hash, role, name) "
                    "VALUES (%s, 'x', %s, %s) RETURNING id", (email, role, name))
        return cur.fetchone()['id']

    counselor = add_user('t-status-c@example.com', 'A Counselor', 'counselor')
    parent = add_user('t-status-p@example.com', 'A Parent', 'parent')

    def add_child(name):
        cur.execute("INSERT INTO children (name, parent_id, school_id) "
                    "VALUES (%s, %s, %s) RETURNING id", (name, parent, brown))
        cid = cur.fetchone()['id']
        day = datetime.strptime(TODAY, '%Y-%m-%d').strftime('%A')
        if day not in ('Saturday', 'Sunday'):
            cur.execute("INSERT INTO registrations (child_id, day_of_week) "
                        "VALUES (%s, %s)", (cid, day))
        return cid

    tapped = add_child('Tapped Child')
    released = add_child('Released Child')
    missing = add_child('Missing Child')
    legacy = add_child('Legacy Row Child')

    cauth = {'Authorization': f'Bearer {token(org, "counselor", counselor)}'}
    aauth = {'Authorization': f'Bearer {token(org, "admin")}'}

    def marks():
        return client.get(f'/api/counselor/attendance?date={TODAY}',
                          headers=cauth).get_json()

    def row(child_id):
        pin(cur, org)
        cur.execute("SELECT on_bus, status, status_note, checked_in_at, "
                    "       checked_out_at "
                    "  FROM attendance_records "
                    " WHERE child_id = %s AND attendance_date = %s",
                    (child_id, TODAY))
        return cur.fetchone()

    # ── The tap writes a status ───────────────────────────────────────────
    client.post('/api/counselor/attendance', headers=cauth,
                json={'date': TODAY,
                      'records': [{'child_id': tapped, 'on_bus': True}]})
    check('tapping a child in records picked_up', row(tapped)['status'], 'picked_up')
    check('and keeps on_bus in step', row(tapped)['on_bus'], 1)
    check('the endpoint the roster reads returns the status',
          marks()[str(tapped)]['status'], 'picked_up')

    client.post('/api/counselor/attendance', headers=cauth,
                json={'date': TODAY,
                      'records': [{'child_id': tapped, 'on_bus': False}]})
    check('untapping records waiting', row(tapped)['status'], 'waiting')
    check('and clears the arrival time', row(tapped)['checked_in_at'], None)

    # ── The release, and the bug that detached it ─────────────────────────
    client.post('/api/counselor/attendance', headers=cauth,
                json={'date': TODAY,
                      'records': [{'child_id': released, 'on_bus': True}]})
    cur.execute(
        "INSERT INTO authorized_pickup_people (child_id, name, relationship, "
        "  created_by) VALUES (%s, 'Grandma', 'Grandmother', %s) RETURNING id",
        (released, parent))
    person = cur.fetchone()['id']
    r = client.post('/api/counselor/pickup/release', headers=cauth,
                    json={'child_id': released, 'person_id': person,
                          'signature': 'data:image/png;base64,'
                                       'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
                                       'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='})
    check('the release succeeds', r.status_code, 201)
    check('and records checked_out', row(released)['status'], 'checked_out')

    before = row(released)['checked_out_at']
    client.post('/api/counselor/attendance', headers=cauth,
                json={'date': TODAY,
                      'records': [{'child_id': released, 'on_bus': False}]})
    after = row(released)
    check('UNTAPPING A RELEASED CHILD DOES NOT ERASE THE RELEASE',
          after['checked_out_at'], before)
    check('and does not rewrite their status', after['status'], 'checked_out')
    pin(cur, org)
    cur.execute("SELECT count(*) AS n FROM pickup_releases WHERE child_id = %s",
                (released,))
    check('the signed release row is still attached to a day that happened',
          cur.fetchone()['n'], 1)

    # ── picked_up and checked_out are different states ────────────────────
    m = marks()
    check('a released child is not reported as in the building',
          m[str(released)]['checked_out_at'] is not None, True)
    check('and the two children read differently',
          (m[str(tapped)]['status'], m[str(released)]['status']),
          ('waiting', 'checked_out'))

    # ── The richer statuses ───────────────────────────────────────────────
    r = client.post('/api/counselor/child-status', headers=cauth,
                    json={'child_id': missing, 'status': 'not_found',
                          'date': TODAY})
    check('a counselor can report a child not found', r.status_code, 200)
    check('which is not the same as absent', row(missing)['status'], 'not_found')
    check('and does not mark them present', row(missing)['on_bus'], 0)

    r = client.post('/api/counselor/child-status', headers=cauth,
                    json={'child_id': missing, 'status': 'issue', 'date': TODAY})
    check('an issue with no note is refused', r.status_code, 400)
    r = client.post('/api/counselor/child-status', headers=cauth,
                    json={'child_id': missing, 'status': 'issue',
                          'note': 'Wrong bus', 'date': TODAY})
    check('an issue with a note is accepted', r.status_code, 200)
    check('and the note is kept', row(missing)['status_note'], 'Wrong bus')

    # R6: signing a child out takes a signature, so this endpoint cannot do it.
    check('checked_out cannot be set without a signature',
          client.post('/api/counselor/child-status', headers=cauth,
                      json={'child_id': missing, 'status': 'checked_out',
                            'date': TODAY}).status_code, 400)
    check('an unknown status is refused',
          client.post('/api/counselor/child-status', headers=cauth,
                      json={'child_id': missing, 'status': 'on_the_moon',
                            'date': TODAY}).status_code, 400)
    check('a released child cannot be re-statused',
          client.post('/api/counselor/child-status', headers=cauth,
                      json={'child_id': released, 'status': 'waiting',
                            'date': TODAY}).status_code, 409)

    # ── Rows written before the column ────────────────────────────────────
    pin(cur, org)
    cur.execute(
        "INSERT INTO attendance_records (child_id, school_id, attendance_date, "
        "  on_bus, checked_in_at) VALUES (%s, %s, %s, 1, NOW())",
        (legacy, brown, TODAY))
    check('a row with no status still reads as picked_up',
          marks()[str(legacy)]['status'], 'picked_up')
    check('derive_status reads a legacy present row', derive_status(None, 1, None),
          'picked_up')
    check('and a legacy released row',
          derive_status(None, 1, datetime.now()), 'checked_out')
    check('and says nothing about a row that was never marked',
          derive_status(None, 0, None), None)
    check('while a stored status always wins',
          derive_status('not_found', 1, None), 'not_found')

    # ── The admin screen speaks the same words ────────────────────────────
    kids = {c['name']: c for c in client.get(
        f'/api/admin/children?date={TODAY}', headers=aauth).get_json()['children']}
    check("the admin list uses the counselor's vocabulary",
          kids['Missing Child']['status'], 'issue')
    check('and shows a released child as checked_out',
          kids['Released Child']['status'], 'checked_out')
    check('and a present one as picked_up, not in_building',
          kids['Legacy Row Child']['status'], 'picked_up')

    # ── Roles ─────────────────────────────────────────────────────────────
    check('a parent cannot set a status',
          client.post('/api/counselor/child-status',
                      headers={'Authorization': f'Bearer {token(org, "parent")}'},
                      json={'child_id': missing, 'status': 'waiting'}).status_code,
          403)

    # Cleanup
    pin(cur, org)
    for table in ('pickup_releases', 'authorized_pickup_people',
                  'attendance_records', 'counselor_schools', 'registrations',
                  'children', 'schools'):
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
    print('All child status checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
