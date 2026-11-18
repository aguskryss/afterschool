"""Tests for cancelling one class on one date (sql/79, daily_ops).

The director's workaround was to take every child out of the class, which
emptied it for every week after and meant enrolling them all again. A
cancellation is per date and leaves the roster alone:

  * On the date, the class is gone from the board, and its children are in
    the care room their grade waits in for those hours.
  * The counselor staffing it is free that day — not on the class, and the
    class is not on their screen.
  * The next week the class is back with the same roster. Enrollments never
    change.
  * Only an admin, only on the class's own weekday, only inside the
    organization. Restoring brings it back.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://owner@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_class_cancellations.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

MODULES = json.dumps({'daily_ops': True})
MONDAY = '2026-08-10'
NEXT_MONDAY = '2026-08-17'
TUESDAY = '2026-08-11'


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


def make_org(cur, slug):
    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, modules) VALUES (%s, %s, %s) "
        "ON CONFLICT (slug) DO UPDATE SET modules = EXCLUDED.modules RETURNING id",
        (slug, slug, MODULES))
    org = cur.fetchone()['id']
    pin(cur, org)
    for table in ('class_cancellations', 'staff_assignments',
                  'care_assignment_rules', 'rooms', 'class_enrollments',
                  'class_sessions', 'absences', 'registrations', 'children',
                  'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))
    return org


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    other = make_org(cur, 't-cancel-other')
    org = make_org(cur, 't-cancel')

    rooms = {}
    for order, name in enumerate(('Ocean Room', 'Gym')):
        cur.execute("INSERT INTO rooms (name, sort_order) VALUES (%s, %s) "
                    "RETURNING id", (name, order))
        rooms[name] = cur.fetchone()['id']
    for block, lo, hi, room in (('3-4', 0, 0, 'Ocean Room'),
                                ('3-4', 1, 4, 'Gym'),
                                ('4-5', 0, 4, 'Ocean Room'),
                                ('5-6', 0, 4, 'Ocean Room')):
        cur.execute("INSERT INTO care_assignment_rules (time_block, grade_min, "
                    "  grade_max, room_id) VALUES (%s,%s,%s,%s)",
                    (block, lo, hi, rooms[room]))

    classes = {}
    for name, start, end in (('Bball 3:15p-4p', '15:15', '16:00'),
                             ('Crafting 4p-4:45p', '16:00', '16:45')):
        cur.execute("INSERT INTO class_sessions (name, day_of_week, start_time, "
                    "  end_time) VALUES (%s, 'Monday', %s, %s) RETURNING id",
                    (name, start, end))
        classes[name] = cur.fetchone()['id']

    cur.execute("INSERT INTO users (email, password_hash, role, name) "
                "VALUES (%s, 'x', 'counselor', 'Katelyn') RETURNING id",
                (f'katelyn-cancel-{org}@example.com',))
    katelyn = cur.fetchone()['id']
    cur.execute("INSERT INTO users (email, password_hash, role, name) "
                "VALUES (%s, 'x', 'parent', 'A Parent') RETURNING id",
                (f'cancel-parent-{org}@example.com',))
    parent = cur.fetchone()['id']
    cur.execute("INSERT INTO schools (name) VALUES ('Brown') RETURNING id")
    school = cur.fetchone()['id']

    kids = {}
    for name, num, hour, in_classes in (
            ('Cara Diaz', 2, 6, ['Bball 3:15p-4p', 'Crafting 4p-4:45p']),
            ('Dan Ebner', 2, 4, ['Bball 3:15p-4p'])):
        cur.execute("INSERT INTO children (name, parent_id, school_id, "
                    "  grade_label, grade_num) VALUES (%s,%s,%s,%s,%s) "
                    "RETURNING id", (name, parent, school, str(num), num))
        kids[name] = cur.fetchone()['id']
        cur.execute("INSERT INTO registrations (child_id, day_of_week, "
                    "  dismissal_time) VALUES (%s, 'Monday', %s)",
                    (kids[name], hour))
        for class_name in in_classes:
            cur.execute("INSERT INTO class_enrollments (child_id, "
                        "  class_session_id) VALUES (%s, %s)",
                        (kids[name], classes[class_name]))

    auth = {'Authorization': f'Bearer {token(org)}'}
    other_auth = {'Authorization': f'Bearer {token(other)}'}
    kauth = {'Authorization':
             f'Bearer {token(org, role="counselor", user_id=katelyn)}'}
    bball = classes['Bball 3:15p-4p']

    client.post('/api/admin/staff-assignments',
                json={'counselor_id': katelyn, 'day_of_week': 'Monday',
                      'class_session_id': bball}, headers=auth)

    def board(date=MONDAY):
        return client.get(f'/api/admin/daily-board?date={date}',
                          headers=auth).get_json()

    def class_names(data):
        return sorted(c['name'] for c in data['classes'])

    def care_names(data, block, room):
        group = next((c for c in data['care'] if c['time_block'] == block
                      and c['room_name'] == room), None)
        return sorted(c['name'] for c in group['children']) if group else []

    def my_titles(date=MONDAY):
        return [b['title'] for b in client.get(
            f'/api/counselor/my-day?date={date}', headers=kauth
        ).get_json().get('blocks', [])]

    def enrolled():
        pin(cur, org)
        cur.execute("SELECT count(*) AS n FROM class_enrollments "
                    " WHERE class_session_id = %s", (bball,))
        return cur.fetchone()['n']

    before = board()
    check('before: Bball runs', 'Bball 3:15p-4p' in class_names(before), True)
    check('before: nobody in the Gym 3-4',
          care_names(before, '3-4', 'Gym'), [])
    check('before: Katelyn has Bball', 'Bball 3:15p-4p' in my_titles(), True)

    # ── Refusals ──────────────────────────────────────────────────────────
    url = f'/api/admin/class-sessions/{bball}/cancellations'
    check('a counselor cannot cancel a class',
          client.post(url, json={'date': MONDAY}, headers=kauth).status_code, 403)
    check('another organization cannot cancel it',
          client.post(url, json={'date': MONDAY},
                      headers=other_auth).status_code, 404)
    check('a date off the class weekday is refused',
          client.post(url, json={'date': TUESDAY}, headers=auth).status_code, 400)
    check('a missing date is refused',
          client.post(url, json={}, headers=auth).status_code, 400)

    # ── The cancellation ──────────────────────────────────────────────────
    r = client.post(url, json={'date': MONDAY, 'reason': 'Coach out sick'},
                    headers=auth)
    check('an admin cancels Bball for one Monday', r.status_code, 201)

    data = board()
    check('THE CLASS IS GONE FROM THAT DAY',
          'Bball 3:15p-4p' in class_names(data), False)
    check('the other class still runs',
          'Crafting 4p-4:45p' in class_names(data), True)
    check("ITS CHILDREN ARE IN THEIR GRADE'S CARE ROOM",
          care_names(data, '3-4', 'Gym'), ['Cara Diaz', 'Dan Ebner'])
    cancelled = data.get('cancelled_classes') or []
    check('the board lists it as cancelled, with the reason',
          [(c['name'], c['reason']) for c in cancelled],
          [('Bball 3:15p-4p', 'Coach out sick')])
    check('and says where each child went',
          [(c['name'], c['goes_to']) for c in cancelled[0]['children']]
          if cancelled else None,
          [('Cara Diaz', 'Gym'), ('Dan Ebner', 'Gym')])
    check('no "class without staff" warning for a class that is not happening',
          [w for w in data['warnings']
           if w['code'] == 'class_without_staff'
           and w.get('label') == 'Bball 3:15p-4p'], [])
    check('THE COUNSELOR IS FREE THAT DAY',
          'Bball 3:15p-4p' in my_titles(), False)
    grid = client.get(f'/api/admin/staff-assignments?date={MONDAY}',
                      headers=auth).get_json()
    check('and the staff grid for the date does not list the class',
          any(c['name'] == 'Bball 3:15p-4p'
              for b in grid['blocks'] for c in b['classes']), False)
    check('THE ROSTER IS UNTOUCHED', enrolled(), 2)
    check('another organization does not see it',
          client.get(f'/api/admin/daily-board?date={MONDAY}',
                     headers=other_auth).get_json().get('cancelled_classes'), [])

    # ── The next week ─────────────────────────────────────────────────────
    nxt = board(NEXT_MONDAY)
    check('THE NEXT MONDAY THE CLASS IS BACK',
          'Bball 3:15p-4p' in class_names(nxt), True)
    check('with the same children',
          sorted(child['name']
                 for session in nxt['classes']
                 if session['name'] == 'Bball 3:15p-4p'
                 for child in session['children']), ['Cara Diaz', 'Dan Ebner'])
    check('and Katelyn on it', 'Bball 3:15p-4p' in my_titles(NEXT_MONDAY), True)

    # ── Restoring ─────────────────────────────────────────────────────────
    check('another organization cannot restore it',
          client.delete(f'{url}/{MONDAY}', headers=other_auth).status_code, 404)
    check('an admin restores it',
          client.delete(f'{url}/{MONDAY}', headers=auth).status_code, 200)
    restored = board()
    check('the class runs that day again',
          'Bball 3:15p-4p' in class_names(restored), True)
    check('and the Gym is empty again', care_names(restored, '3-4', 'Gym'), [])
    check('restoring twice is a 404',
          client.delete(f'{url}/{MONDAY}', headers=auth).status_code, 404)

    conn.close()
    print()
    if failures:
        print(f'{len(failures)} FAILED: {failures}')
        return 1
    print('All passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
