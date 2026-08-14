"""Tests for the numbers on the admin dashboard.

Four bugs lived behind "156 children / 0 of 74 in the building", and each one
is a property here rather than a regression note:

  * "Today" is the JCC's date, not the container's. Render runs UTC, so from
    about 7pm Eastern every dated endpoint rolled over to tomorrow mid-pickup.
    The test asserts two organizations in zones 25 hours apart get *different*
    dates from the same request at the same instant — which can only happen if
    organizations.timezone is actually being read.
  * A child marked absent who is standing in the building counts as present.
    The absence is a prediction; the check-in is an observation.
  * A school where nobody is enrolled today still appears, with expected 0.
    Dropping it made "not their day" indistinguishable from "no such school".
  * PUT /api/admin/children/<id> with no `days` key changes nothing, and the
    weekdays it keeps do not lose their dismissal hour.

Plus the two smaller ones: the polled headcount pins the tenant so a
superadmin cannot sum every JCC into one board, and /api/admin/stats reports
how many children are enrolled on any weekday, which is the whole explanation
for the gap between the two headline numbers.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_dashboard_numbers.py
"""

import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

MONDAY = '2026-08-03'

# 25 hours apart, so they are never on the same calendar date. That is what
# makes the timezone assertion below meaningful rather than coincidental.
FAR_EAST = 'Pacific/Kiritimati'   # UTC+14
FAR_WEST = 'Pacific/Niue'         # UTC-11


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


def make_org(cur, slug, name, tzname, modules='{}'):
    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, timezone, modules) "
        "VALUES (%s, %s, %s, %s::jsonb) "
        "ON CONFLICT (slug) DO UPDATE SET timezone = EXCLUDED.timezone, "
        "  modules = EXCLUDED.modules RETURNING id",
        (slug, name, tzname, modules),
    )
    org_id = cur.fetchone()['id']
    pin(cur, org_id)
    for table in ('registrations', 'attendance_records', 'absences',
                  'child_contacts', 'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org_id,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org_id,))
    return org_id


def add_school(cur, name):
    cur.execute("INSERT INTO schools (name) VALUES (%s) RETURNING id", (name,))
    return cur.fetchone()['id']


def add_parent(cur, email, name):
    cur.execute("INSERT INTO users (email, password_hash, role, name) "
                "VALUES (%s, 'x', 'parent', %s) RETURNING id", (email, name))
    return cur.fetchone()['id']


def add_child(cur, name, school_id, parent_id, days):
    cur.execute("INSERT INTO children (name, parent_id, school_id) "
                "VALUES (%s, %s, %s) RETURNING id", (name, parent_id, school_id))
    child_id = cur.fetchone()['id']
    for day, hour in days:
        cur.execute("INSERT INTO registrations (child_id, day_of_week, dismissal_time) "
                    "VALUES (%s, %s, %s)", (child_id, day, hour))
    return child_id


def token(org_id, role='admin'):
    with app.app_context():
        return create_access_token(
            identity='1', additional_claims={'role': role, 'org': org_id})


def auth(org_id, role='admin'):
    return {'Authorization': f'Bearer {token(org_id, role)}'}


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    # ── 1. "Today" is the organization's date ─────────────────────────────
    #
    # Two organizations, same instant, zones 25 hours apart. If the container
    # clock were still in charge both would answer the same thing.
    east = make_org(cur, 't-dash-east', 'Far East JCC', FAR_EAST,
                    '{"check_in_out": true}')
    west = make_org(cur, 't-dash-west', 'Far West JCC', FAR_WEST,
                    '{"check_in_out": true}')

    r_east = client.get('/api/admin/children', headers=auth(east)).get_json()
    r_west = client.get('/api/admin/children', headers=auth(west)).get_json()

    check("the eastern JCC gets its own date",
          r_east['date'],
          datetime.now(ZoneInfo(FAR_EAST)).strftime('%Y-%m-%d'))
    check("the western JCC gets its own date",
          r_west['date'],
          datetime.now(ZoneInfo(FAR_WEST)).strftime('%Y-%m-%d'))
    check("two organizations 25 hours apart do not share a date",
          r_east['date'] != r_west['date'], True)
    check("the weekday follows the date, not the container",
          r_east['day'],
          datetime.now(ZoneInfo(FAR_EAST)).strftime('%A'))

    # An unusable zone must degrade, not 500. Someone will eventually type one.
    pin(cur, None, superadmin=True)
    cur.execute("UPDATE organizations SET timezone = 'Mars/Olympus' WHERE id = %s",
                (west,))
    pin(cur, west)
    rr = client.get('/api/admin/children', headers=auth(west))
    check('an unknown timezone falls back instead of failing', rr.status_code, 200)
    pin(cur, None, superadmin=True)
    cur.execute("UPDATE organizations SET timezone = %s WHERE id = %s",
                (FAR_WEST, west))

    # ── 2, 3. The headcount ───────────────────────────────────────────────
    org = make_org(cur, 't-dash-count', 'Counting JCC', 'America/New_York',
                   '{"check_in_out": true}')
    brown = add_school(cur, 'Brown')
    glover = add_school(cur, 'Glover')
    p = add_parent(cur, 't-dash-parent@example.com', 'A Parent')

    plain = add_child(cur, 'Plain Monday', brown, p, [('Monday', 5)])
    absent_away = add_child(cur, 'Absent Away', brown, p, [('Monday', 5)])
    absent_here = add_child(cur, 'Absent But Here', brown, p, [('Monday', 5)])
    # Two different ways to be "not in today", which must count the same:
    # never enrolled at all, and enrolled on a different weekday.
    add_child(cur, 'No Days At All', brown, p, [])
    add_child(cur, 'Brown Thursday Only', brown, p, [('Thursday', 3)])
    # Glover has a child, but only on Tuesday — on Monday it is an empty school.
    add_child(cur, 'Tuesday Only', glover, p, [('Tuesday', 4)])

    for cid in (absent_away, absent_here):
        cur.execute("INSERT INTO absences (child_id, absence_date) VALUES (%s, %s)",
                    (cid, MONDAY))
    cur.execute(
        "INSERT INTO attendance_records (child_id, school_id, attendance_date, "
        "  on_bus, checked_in_at) VALUES (%s, %s, %s, 1, NOW())",
        (absent_here, brown, MONDAY))

    body = client.get(f'/api/attendance/headcount?date={MONDAY}',
                      headers=auth(org)).get_json()
    by_school = {s['school']: s for s in body['schools']}

    check('a school with nobody enrolled today still appears',
          sorted(by_school), ['Brown', 'Glover'])
    check('the empty school reports zero expected rather than vanishing',
          by_school['Glover']['expected'], 0)
    check('a child in the building counts even though a parent reported them absent',
          by_school['Brown']['present'], 1)
    check('and they count in the denominator too',
          by_school['Brown']['expected'], 2)
    check('the one who is actually away is reported absent',
          by_school['Brown']['absent'], 1)
    check('not-in-today counts both never-enrolled and enrolled-another-day',
          by_school['Brown']['unscheduled'], 2)
    check('the empty school counts its Tuesday child as not in today',
          by_school['Glover']['unscheduled'], 1)
    # The property the dashboard leans on: nobody is double-counted and
    # nobody is lost, so the per-school numbers add back up to the tile.
    total = sum(s['expected'] + s['absent'] + s['unscheduled']
                for s in body['schools'])
    stats_now = client.get('/api/admin/stats', headers=auth(org)).get_json()
    check('expected + absent + unscheduled accounts for every active child',
          total, stats_now['children'])

    # Releasing moves a child out of present without changing the denominator.
    cur.execute("UPDATE attendance_records SET checked_out_at = NOW() "
                "WHERE child_id = %s AND attendance_date = %s", (absent_here, MONDAY))
    body = client.get(f'/api/attendance/headcount?date={MONDAY}',
                      headers=auth(org)).get_json()
    brown_row = {s['school']: s for s in body['schools']}['Brown']
    check('a released child leaves the present count', brown_row['present'], 0)
    check('and lands in released', brown_row['released'], 1)
    check('while the denominator holds still', brown_row['expected'], 2)

    # ── 4. The PUT that used to wipe a schedule ───────────────────────────
    def days_of(child_id):
        pin(cur, org)
        cur.execute("SELECT day_of_week, dismissal_time FROM registrations "
                    "WHERE child_id = %s ORDER BY day_of_week", (child_id,))
        return [(r['day_of_week'], r['dismissal_time']) for r in cur.fetchall()]

    kid = add_child(cur, 'Schedule Holder', brown, p,
                    [('Monday', 5), ('Tuesday', 4)])
    check('the child starts with two days and their hours',
          days_of(kid), [('Monday', 5), ('Tuesday', 4)])

    client.put(f'/api/admin/children/{kid}', json={'name': 'Renamed'},
               headers=auth(org))
    check('a body with no days key leaves the schedule alone',
          days_of(kid), [('Monday', 5), ('Tuesday', 4)])

    client.put(f'/api/admin/children/{kid}',
               json={'days': ['Monday', 'Wednesday']}, headers=auth(org))
    check('a kept weekday does not lose its dismissal hour',
          days_of(kid), [('Monday', 5), ('Wednesday', None)])

    rr = client.put(f'/api/admin/children/{kid}', json={'days': ['Funday']},
                    headers=auth(org))
    check('an invalid weekday is rejected', rr.status_code, 400)
    check('and the rejection changes nothing',
          days_of(kid), [('Monday', 5), ('Wednesday', None)])

    client.put(f'/api/admin/children/{kid}', json={'days': []}, headers=auth(org))
    check('an explicit empty list does clear the schedule', days_of(kid), [])

    # ── 5. children_enrolled ──────────────────────────────────────────────
    stats = client.get('/api/admin/stats', headers=auth(org)).get_json()
    # Seven children exist; 'No Days At All' and the now-cleared
    # 'Schedule Holder' have no weekday, so five are enrolled.
    check('stats counts every active child', stats['children'], 7)
    check('stats separately counts the ones enrolled on some weekday',
          stats['children_enrolled'], 5)
    check('the two are different numbers, which is the point',
          stats['children'] != stats['children_enrolled'], True)

    # ── 6. The polled headcount pins the tenant ───────────────────────────
    # A superadmin token satisfies org_isolation for every row. Without the
    # pin, this route would sum every JCC into one board.
    rr = client.get(f'/api/attendance/headcount?date={MONDAY}',
                    headers=auth(None, 'superadmin'))
    payload = rr.get_json() if rr.status_code == 200 else {'schools': []}
    check('a superadmin gets no cross-tenant headcount',
          payload.get('schools'), [])

    # Cleanup
    pin(cur, None, superadmin=True)
    cur.execute("SELECT id FROM organizations WHERE slug LIKE 't-dash-%'")
    org_ids = [r['id'] for r in cur.fetchall()]
    for oid in org_ids:
        pin(cur, oid)
        for table in ('registrations', 'attendance_records', 'absences',
                      'child_contacts', 'children', 'schools'):
            cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (oid,))
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM users WHERE organization_id = ANY(%s)", (org_ids,))
    cur.execute("DELETE FROM organizations WHERE id = ANY(%s)", (org_ids,))
    check('cleanup removes the test organizations', cur.rowcount, len(org_ids))
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All dashboard number checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
