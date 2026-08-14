"""Tests for the two attendance sheets — /api/admin/daily-board (daily_ops).

§3.5 `{Day} - Classes` and §3.6 `{Day} - Care`: the pages the director builds by
hand every afternoon. This generates them.

THE FIVE THAT MATTER:

  1. IT IS THE SAME ANSWER AS THE COUNSELOR'S SCREEN. Both read one
     _plan_for_day call, so a child's `Dismiss To` on the board and on the phone
     of the counselor holding them cannot differ. Asserted by comparing the two
     endpoints directly rather than by reasoning about it.

  2. The board is the whole program; my-day is one slice of it. Every block a
     counselor sees has to appear here, plus the ones nobody is assigned to.

  3. The warnings of §6.3 are here and are specific: a child with no computable
     destination, a room with children and no adult, a class over its capacity.

  4. The headcount excludes absent children, on both sheets. It is the number the
     grade ranges get moved to balance, so a headcount that counts children who
     are at home is worse than none.

  5. Only an admin. A counselor reads their own day, not the whole program.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://owner@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_daily_board.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

MODULES = json.dumps({'daily_ops': True, 'absences': True})
MODULES_OFF = json.dumps({'daily_ops': False})

MONDAY = '2026-08-10'
SATURDAY = '2026-08-15'

#: (name, weekday, start, end, location, capacity)
CLASSES = [
    ('Bball 3:15p-4p', 'Monday', '15:15', '16:00', 'Courts', 2),
    ('Crafting 4p-4:45p', 'Monday', '16:00', '16:45', 'WKL', None),
    ('Swim L1/2 3p-3:30p', 'Monday', '15:00', '15:30', 'Pool', None),
]

CARE_RULES = [
    ('3-4', 0, 0, 'Ocean Room'),
    ('3-4', 1, 4, 'Gym'),
    ('4-5', 0, 4, 'Ocean Room'),
    ('5-6', 0, 4, 'Ocean Room'),
]

#: (name, grade_label, grade_num, dismissal hour, [class names])
CHILDREN = [
    ('Beau Farden', 'K', 0, 4, ['Swim L1/2 3p-3:30p']),
    ('Cara Diaz', '2', 2, 6, ['Bball 3:15p-4p', 'Crafting 4p-4:45p']),
    ('Dan Ebner', '2', 2, 4, ['Bball 3:15p-4p']),
    # Puts Bball at 3 children against a capacity of 2.
    ('Elle Roth', '3', 3, 5, ['Bball 3:15p-4p']),
    # No pickup hour: the "no computable destination" warning.
    ('Nora Vance', '1', 1, None, ['Bball 3:15p-4p']),
    ('Absent Amy', 'K', 0, 5, []),
]


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


def make_org(cur, slug, name, modules):
    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, modules) VALUES (%s, %s, %s) "
        "ON CONFLICT (slug) DO UPDATE SET modules = EXCLUDED.modules RETURNING id",
        (slug, name, modules))
    return cur.fetchone()['id']


def wipe(cur, org):
    pin(cur, org)
    for table in ('staff_assignments', 'care_assignment_rules', 'rooms',
                  'class_enrollments', 'class_sessions', 'absences',
                  'registrations', 'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))


def seed(cur, org):
    pin(cur, org)
    rooms = {}
    for order, name in enumerate(('Ocean Room', 'Gym')):
        cur.execute("INSERT INTO rooms (name, sort_order) VALUES (%s, %s) "
                    "RETURNING id", (name, order))
        rooms[name] = cur.fetchone()['id']

    classes = {}
    for name, day, start, end, where, cap in CLASSES:
        cur.execute(
            "INSERT INTO class_sessions (name, day_of_week, start_time, "
            "  end_time, location, capacity) VALUES (%s,%s,%s,%s,%s,%s) "
            "RETURNING id", (name, day, start, end, where, cap))
        classes[name] = cur.fetchone()['id']

    for block, lo, hi, room in CARE_RULES:
        cur.execute(
            "INSERT INTO care_assignment_rules (time_block, grade_min, "
            "  grade_max, room_id) VALUES (%s,%s,%s,%s)",
            (block, lo, hi, rooms[room]))

    people = {}
    for name in ('Katelyn', 'Mollie'):
        cur.execute(
            "INSERT INTO users (email, password_hash, role, name) "
            "VALUES (%s, 'x', 'counselor', %s) RETURNING id",
            (f'{name.lower()}-board-{org}@example.com', name))
        people[name] = cur.fetchone()['id']
    cur.execute(
        "INSERT INTO users (email, password_hash, role, name) "
        "VALUES (%s, 'x', 'parent', 'A Parent') RETURNING id",
        (f'board-parent-{org}@example.com',))
    parent = cur.fetchone()['id']

    cur.execute("INSERT INTO schools (name) VALUES ('Brown') RETURNING id")
    school = cur.fetchone()['id']
    kids = {}
    for name, label, num, hour, in_classes in CHILDREN:
        cur.execute(
            "INSERT INTO children (name, parent_id, school_id, grade_label, "
            "  grade_num) VALUES (%s,%s,%s,%s,%s) RETURNING id",
            (name, parent, school, label, num))
        kids[name] = cur.fetchone()['id']
        cur.execute("INSERT INTO registrations (child_id, day_of_week, "
                    "  dismissal_time) VALUES (%s,'Monday',%s)",
                    (kids[name], hour))
        for class_name in in_classes:
            cur.execute("INSERT INTO class_enrollments (child_id, "
                        "  class_session_id) VALUES (%s,%s)",
                        (kids[name], classes[class_name]))

    cur.execute("INSERT INTO absences (child_id, absence_date) VALUES (%s,%s)",
                (kids['Absent Amy'], MONDAY))
    return rooms, classes, people


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    org = make_org(cur, 't-board', 'Board JCC', MODULES)
    other = make_org(cur, 't-board-other', 'Other JCC', MODULES)
    dark = make_org(cur, 't-board-dark', 'No Daily Ops JCC', MODULES_OFF)
    wipe(cur, org)
    wipe(cur, other)
    rooms, classes, people = seed(cur, org)

    auth = {'Authorization': f'Bearer {token(org)}'}
    other_auth = {'Authorization': f'Bearer {token(other)}'}

    def board(date=MONDAY, headers=auth):
        return client.get(f'/api/admin/daily-board?date={date}',
                          headers=headers).get_json()

    def sheet(data, name):
        return next(c for c in data['classes'] if c['name'] == name)

    def care(data, block, room):
        return next(c for c in data['care']
                    if c['time_block'] == block and c['room_name'] == room)

    # ── Property 5: only an admin ─────────────────────────────────────────
    check('the board is refused when daily_ops is off',
          client.get('/api/admin/daily-board',
                     headers={'Authorization': f'Bearer {token(dark)}'}
                     ).status_code, 403)
    for role in ('counselor', 'parent'):
        check(f'a {role} cannot read the whole board',
              client.get('/api/admin/daily-board',
                         headers={'Authorization': f'Bearer {token(org, role=role)}'}
                         ).status_code, 403)
    check('a weekend says the program is closed', board(SATURDAY)['closed'], True)
    check('and carries no sheets', (board(SATURDAY)['classes'],
                                   board(SATURDAY)['care']), ([], []))
    check('a date that is not a date is refused',
          client.get('/api/admin/daily-board?date=nope',
                     headers=auth).status_code, 400)

    # ── The Classes sheet ────────────────────────────────────────────────
    data = board()
    check('every class of the weekday gets a block',
          sorted(c['name'] for c in data['classes']),
          sorted(n for n, d, *_ in CLASSES if d == 'Monday'))
    check('a block carries its hours and its room, as the header does',
          [(sheet(data, 'Bball 3:15p-4p')[k]) for k in
           ('start_time', 'end_time', 'location')],
          ['15:15', '16:00', 'Courts'])
    # Elle goes to Ocean and not to the Gym, and that is the block lookup being
    # right: Bball ends at 4:00, so she enters the FOUR-to-five block, whose only
    # rule sends K-4 to Ocean. The Gym is the three-to-four room she never
    # reaches. Reading the wrong block here is how a child gets sent to a room
    # their parent is not standing in.
    check('THE DISMISS TO COLUMN IS THE ENGINE\'S ANSWER',
          [(c['name'], c['dismiss_to'], c['dismiss_kind'])
           for c in sheet(data, 'Bball 3:15p-4p')['children']],
          [('Cara Diaz', 'Crafting 4p-4:45p', 'class'),
           ('Dan Ebner', 'PARENTS', 'parents'),
           ('Elle Roth', 'Ocean Room', 'care'),
           ('Nora Vance', None, 'unknown')])
    check('the chained child carries her ** convention',
          [c['name'] for c in sheet(data, 'Bball 3:15p-4p')['children']
           if c['chained']], ['Cara Diaz'])
    check('and every row has the school and pickup hour of §3.5',
          [(c['school'], c['dismissal_time'])
           for c in sheet(data, 'Swim L1/2 3p-3:30p')['children']],
          [('Brown', 4)])

    # ── The Care sheet ───────────────────────────────────────────────────
    check('care blocks come back per room per hour, with their grade label',
          [(c['time_block'], c['room_name'], c['grade_label'])
           for c in data['care']],
          [('3-4', 'Ocean Room', 'K'), ('3-4', 'Gym', '1-4'),
           ('4-5', 'Ocean Room', 'K-4'), ('5-6', 'Ocean Room', 'K-4')])
    check('THE FROM/TO COLUMN NAMES BOTH DIRECTIONS',
          [(c['name'], c['from_class'], c['to_class'])
           for c in care(data, '3-4', 'Ocean Room')['children']],
          [('Beau Farden', 'Swim L1/2 3p-3:30p', None),
           ('Absent Amy', None, None)])
    check('and the bold is there for the one pulled out by a class',
          [(c['name'], c['partial'])
           for c in care(data, '3-4', 'Ocean Room')['children']],
          [('Beau Farden', True), ('Absent Amy', False)])

    # ── Property 4: the headcount excludes the absent ─────────────────────
    ocean = care(data, '3-4', 'Ocean Room')
    # Listed, and last: out of the way of the children who are actually there.
    check('the absent child is listed', [c['name'] for c in ocean['children']],
          ['Beau Farden', 'Absent Amy'])
    check('AND IS NOT IN THE HEADCOUNT', ocean['present_count'], 1)
    check('the same holds on the Classes sheet',
          sheet(data, 'Bball 3:15p-4p')['present_count'], 4)

    # ── Property 3: the warnings of §6.3 ─────────────────────────────────
    codes = {w['code'] for w in data['warnings']}
    check('a child with no computable destination is reported',
          'no_dismissal_time' in codes, True)
    check('A ROOM WITH CHILDREN AND NOBODY IN IT IS REPORTED',
          'room_without_staff' in codes, True)
    check('so is a class with nobody running it',
          'class_without_staff' in codes, True)
    check('AND A CLASS OVER ITS CAPACITY',
          [w['label'] for w in data['warnings']
           if w['code'] == 'class_over_capacity'], ['Bball 3:15p-4p'])

    # Staffing the blocks clears the staffing warnings and nothing else.
    for body in ({'class_session_id': classes['Bball 3:15p-4p']},
                 {'room_id': rooms['Ocean Room'], 'time_block': '3-4'}):
        client.post('/api/admin/staff-assignments',
                    json={'counselor_id': people['Katelyn'],
                          'day_of_week': 'Monday', **body}, headers=auth)
    staffed = board()
    check('the staffed class names its crew in the block header',
          [p['name'] for p in sheet(staffed, 'Bball 3:15p-4p')['staff']],
          ['Katelyn'])
    check('and the staffed room does too',
          [p['name'] for p in care(staffed, '3-4', 'Ocean Room')['staff']],
          ['Katelyn'])
    check('the over-capacity warning is untouched by staffing',
          [w['label'] for w in staffed['warnings']
           if w['code'] == 'class_over_capacity'], ['Bball 3:15p-4p'])

    # A person stood down for the date shows on the sheet, struck through, so the
    # header is not silently short an adult.
    client.post('/api/admin/staff-assignments',
                json={'counselor_id': people['Katelyn'],
                      'assignment_date': MONDAY,
                      'room_id': rooms['Ocean Room'], 'time_block': '3-4',
                      'status': 'removed'}, headers=auth)
    stood = board()
    check('the stood-down counselor is named on the sheet',
          care(stood, '3-4', 'Ocean Room')['stood_down'], ['Katelyn'])
    check('and the room reads as unstaffed again',
          care(stood, '3-4', 'Ocean Room')['staff'], [])
    check('so the warning comes back',
          any(w['code'] == 'room_without_staff' for w in stood['warnings']), True)
    check('while the following Monday still has her',
          [p['name'] for p in care(board('2026-08-17'), '3-4',
                                   'Ocean Room')['staff']], ['Katelyn'])

    # ── Property 1: the board and the counselor agree, checked directly ───
    mine = client.get(f'/api/counselor/my-day?date={MONDAY}', headers={
        'Authorization': f'Bearer {token(org, role="counselor", user_id=people["Katelyn"])}'
    }).get_json()
    bball_mine = next(b for b in mine['blocks']
                      if b['title'] == 'Bball 3:15p-4p')
    bball_board = sheet(board(), 'Bball 3:15p-4p')
    check("THE COUNSELOR'S SCREEN AND THE BOARD SAY THE SAME THING",
          [(c['name'], c['dismiss_to']) for c in bball_mine['children']],
          [(c['name'], c['dismiss_to']) for c in bball_board['children']])
    check('down to the headcount',
          bball_mine['present_count'], bball_board['present_count'])

    # ── Property 2: the board is the whole program ───────────────────────
    check('every block the counselor sees is on the board',
          all(any(c['name'] == b['title'] for c in board()['classes'])
              or any(c['room_name'] == b['title'] for c in board()['care'])
              for b in mine['blocks']), True)
    check('AND THE BOARD HAS THE BLOCKS NOBODY IS ASSIGNED TO',
          len(board()['classes']) + len(board()['care'])
          > len(mine['blocks']), True)

    # ── The other JCC ────────────────────────────────────────────────────
    check('THE OTHER JCC SEES AN EMPTY AFTERNOON',
          (board(headers=other_auth)['classes'],
           board(headers=other_auth)['care']), ([], []))

    # ── Cleanup ──────────────────────────────────────────────────────────
    for scope in (org, other):
        wipe(cur, scope)
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM organizations WHERE slug IN "
                "('t-board', 't-board-other', 't-board-dark')")
    check('cleanup removes the test organizations', cur.rowcount, 3)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All daily board checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
