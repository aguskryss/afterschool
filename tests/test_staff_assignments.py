"""Tests for the staff assignments — who is in each class and each care room.

This is the table the director actually asked for: the counselor lists that live
in the header of every block on the two attendance sheets, and that no table
could hold until sql/37.

THE SIX THAT MATTER:

  1. The photo's headers can be reproduced and read back. `Ocean Room (K):
     Katelyn, LaRae & Lila` and `Bball 3:15p-4p: Fischer, Mattea, Mollie`, with
     one counselor in two blocks of the same day.

  2. MOVING A GRADE RANGE DOES NOT MOVE THE STAFF. The assignment points at
     (room_id, time_block), never at a care rule, because R7 says the grade
     split "varies with headcount" and §6.3 exists so she can move it. If the
     staff hung off the rule, editing "Gym (1-4)" into "Gym (2-4)" would delete
     Katelyn from the Gym.

  3. The CHECKs of sql/37 hold: a template row or a dated row but never both, a
     class or a room but never both, a room shift always with a block, a class
     shift never with one, and 'removed' only for a date.

  4. The partial uniques actually dedupe. PER_ORG_UNIQUES could not do this —
     it emits a plain UNIQUE with no NULLS NOT DISTINCT, and half these columns
     are nullable, so it would have deduped nothing while looking like it did.

  5. Deleting a room or a class with staff on it is refused, not cascaded. Both
     FKs are ON DELETE CASCADE and this data exists nowhere else: the roster
     spreadsheet does not carry it.

  6. The other JCC sees none of it, and cannot point an assignment at this
     one's rooms or people.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://owner@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_staff_assignments.py
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
MODULES_OFF = json.dumps({'daily_ops': False})

#: A Monday off the June workbook: the classes, their hours, their location.
CLASSES = [
    ('Bball 3:15p-4p', 'Monday', '15:15', '16:00', 'Courts'),
    ('Crafting 4p-4:45p', 'Monday', '16:00', '16:45', 'WKL'),
    ('Swim L1/2 3p-3:30p', 'Monday', '15:00', '15:30', 'Pool'),
    ('Chess', 'Monday', None, None, None),   # hours never filled in
    ('Swim T 3:30p-4:30p', 'Tuesday', '15:30', '16:30', 'Pool'),
]

#: The five care rules in the photo's headers, as whole-week rules.
CARE_RULES = [
    ('3-4', 0, 0, 'Ocean Room'),
    ('3-4', 1, 4, 'Gym'),
    ('4-5', 0, 1, 'Ocean Room'),
    ('4-5', 2, 4, 'Gym'),
    ('5-6', 0, 4, 'Ocean Room'),
]

#: The counselors named in the two sheets' headers.
STAFF = ('Katelyn', 'LaRae', 'Lila', 'Fischer', 'Mattea', 'Mollie')


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
            identity=user_id, additional_claims={'role': role, 'org': org_id})


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
                  'class_enrollments', 'class_sessions', 'registrations',
                  'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))


def seed(cur, org):
    """Rooms, classes, care rules, a small roster and the six counselors."""
    pin(cur, org)
    rooms = {}
    for order, name in enumerate(('Ocean Room', 'Gym', 'Playground')):
        cur.execute("INSERT INTO rooms (name, sort_order) VALUES (%s, %s) "
                    "RETURNING id", (name, order))
        rooms[name] = cur.fetchone()['id']

    classes = {}
    for name, day, start, end, where in CLASSES:
        cur.execute(
            "INSERT INTO class_sessions (name, day_of_week, start_time, "
            "  end_time, location) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (name, day, start, end, where))
        classes[name] = cur.fetchone()['id']

    for block, lo, hi, room in CARE_RULES:
        cur.execute(
            "INSERT INTO care_assignment_rules (time_block, grade_min, "
            "  grade_max, room_id) VALUES (%s, %s, %s, %s)",
            (block, lo, hi, rooms[room]))

    people = {}
    for name in STAFF:
        cur.execute(
            "INSERT INTO users (email, password_hash, role, name) "
            "VALUES (%s, 'x', 'counselor', %s) RETURNING id",
            (f'{name.lower()}-{org}@example.com', name))
        people[name] = cur.fetchone()['id']
    cur.execute(
        "INSERT INTO users (email, password_hash, role, name) "
        "VALUES (%s, 'x', 'parent', 'A Parent') RETURNING id",
        (f'staff-parent-{org}@example.com',))
    parent = cur.fetchone()['id']

    cur.execute("INSERT INTO schools (name) VALUES ('Brown') RETURNING id")
    school = cur.fetchone()['id']
    for index, (label, num) in enumerate((('K', 0), ('1', 1), ('2', 2))):
        cur.execute(
            "INSERT INTO children (name, parent_id, school_id, grade_label, "
            "  grade_num) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (f'Child {index}', parent, school, label, num))
        cur.execute("INSERT INTO registrations (child_id, day_of_week, "
                    "  dismissal_time) VALUES (%s, 'Monday', 6)",
                    (cur.fetchone()['id'],))
    return rooms, classes, people, parent


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    org = make_org(cur, 't-staff', 'Staff JCC', MODULES)
    other = make_org(cur, 't-staff-other', 'Other JCC', MODULES)
    dark = make_org(cur, 't-staff-dark', 'No Daily Ops JCC', MODULES_OFF)
    wipe(cur, org)
    wipe(cur, other)

    auth = {'Authorization': f'Bearer {token(org)}'}
    other_auth = {'Authorization': f'Bearer {token(other)}'}
    rooms, classes, people, parent = seed(cur, org)

    def board(query='?day=Monday', headers=auth):
        return client.get(f'/api/admin/staff-assignments{query}',
                          headers=headers).get_json()

    def put(body, headers=auth):
        return client.post('/api/admin/staff-assignments', json=body,
                           headers=headers)

    def to_class(name, who, day='Monday', **extra):
        return put({'counselor_id': people[who] if who in people else who,
                    'day_of_week': day, 'class_session_id': classes[name],
                    **extra})

    def to_room(name, block, who, day='Monday', **extra):
        body = {'counselor_id': people[who] if who in people else who,
                'room_id': rooms[name], 'time_block': block, **extra}
        if day is not None:
            body['day_of_week'] = day
        return put(body)

    def slot_staff(data, block, *, room=None, class_name=None):
        found = next(b for b in data['blocks'] if b['time_block'] == block)
        if room:
            entry = next(r for r in found['rooms'] if r['room_name'] == room)
        else:
            entry = next(c for c in found['classes'] if c['name'] == class_name)
        return [p['counselor_name'] for p in entry['staff']]

    # ── The module gate and the roles ─────────────────────────────────────
    dark_auth = {'Authorization': f'Bearer {token(dark)}'}
    check('the schedule is refused when daily_ops is off',
          client.get('/api/admin/staff-assignments',
                     headers=dark_auth).status_code, 403)
    for role in ('counselor', 'parent'):
        headers = {'Authorization': f'Bearer {token(org, role=role)}'}
        check(f'a {role} cannot read the schedule',
              client.get('/api/admin/staff-assignments',
                         headers=headers).status_code, 403)
        check(f'a {role} cannot assign anyone',
              put({'counselor_id': people['Lila'], 'day_of_week': 'Monday',
                   'room_id': rooms['Gym'], 'time_block': '3-4'},
                  headers=headers).status_code, 403)

    # ── The grid, before anybody is in it ─────────────────────────────────
    empty = board()
    check('the blocks are the three of the afternoon',
          [b['time_block'] for b in empty['blocks']], ['3-4', '4-5', '5-6'])
    check('a class sits in the block its hours START in',
          [(b['time_block'], sorted(c['name'] for c in b['classes']))
           for b in empty['blocks']],
          [('3-4', ['Bball 3:15p-4p', 'Swim L1/2 3p-3:30p']),
           ('4-5', ['Crafting 4p-4:45p']), ('5-6', [])])
    check('a class with no hours is listed apart, not dropped',
          [c['name'] for c in empty['unscheduled_classes']], ['Chess'])
    check('the care rooms of each block come from the rules',
          [(b['time_block'], [(r['room_name'], r['grade_label'])
                              for r in b['rooms']])
           for b in empty['blocks']],
          [('3-4', [('Ocean Room', 'K'), ('Gym', '1-4')]),
           ('4-5', [('Ocean Room', 'K-1'), ('Gym', '2-4')]),
           ('5-6', [('Ocean Room', 'K-4')])])
    check('EVERY SLOT WITH NOBODY IN IT IS REPORTED',
          len(empty['warnings']), 3 + 5)
    check('the pickers offer the counselors, not the parents',
          sorted(c['name'] for c in empty['counselors']), sorted(STAFF))
    check('a Tuesday class does not show up on Monday',
          [c['name'] for b in empty['blocks'] for c in b['classes']
           if 'Swim T' in c['name']], [])

    # ── The photo's headers, reproduced ───────────────────────────────────
    for who in ('Katelyn', 'LaRae', 'Lila'):
        check(f'{who} goes into Ocean 3-4',
              to_room('Ocean Room', '3-4', who).status_code, 201)
    for who in ('Fischer', 'Mattea', 'Mollie'):
        check(f'{who} goes into Bball',
              to_class('Bball 3:15p-4p', who).status_code, 201)
    # Mollie is in Bball AND in the Gym at 4-5; Mattea in Bball and Crafting.
    check('Mollie can also take the Gym at 4-5',
          to_room('Gym', '4-5', 'Mollie').status_code, 201)
    check('and Mattea can also take Crafting',
          to_class('Crafting 4p-4:45p', 'Mattea').status_code, 201)

    loaded = board()
    check('OCEAN 3-4 READS BACK AS THE SHEET WROTE IT',
          slot_staff(loaded, '3-4', room='Ocean Room'),
          ['Katelyn', 'LaRae', 'Lila'])
    check('AND SO DOES BBALL',
          slot_staff(loaded, '3-4', class_name='Bball 3:15p-4p'),
          ['Fischer', 'Mattea', 'Mollie'])
    check('one person in two blocks of the same day is two assignments',
          slot_staff(loaded, '4-5', room='Gym'), ['Mollie'])
    check('the empty-slot count drops as slots fill',
          len(loaded['warnings']), 8 - 4)
    # Eight shifts so far: three in Ocean, three in Bball, Mollie in the Gym and
    # Mattea in Crafting. None of them is a dated override.
    check('nothing is marked as a one-day override yet',
          [p['only_today'] for b in loaded['blocks']
           for s in (b['rooms'] + b['classes']) for p in s['staff']],
          [False] * 8)
    check('the room slot carries the headcount she balances by',
          [(r['room_name'], r['grade_label'], r['headcount'])
           for r in loaded['blocks'][0]['rooms']],
          [('Ocean Room', 'K', 1), ('Gym', '1-4', 2)])

    # ── The same afternoon read one person at a time (`M-Staff`) ──────────
    # The grid answers "who is in the Gym at four". This answers "what does
    # Mattea do on Monday", which is the other question the office asks and the
    # one the paper sheet is shaped for. Both come out of one resolution, so the
    # test that matters is that they agree.
    def person(data, name):
        return next(p for p in data['people'] if p['name'] == name)

    def shifts(data, name, block):
        return [e['label'] for e in person(data, name)['blocks'][block]]

    rows = board()
    check('every staffable person has a row, not only the busy ones',
          sorted(p['name'] for p in rows['people']), sorted(STAFF))
    check('AND THE ROW READS ACROSS THE WAY THE SHEET DOES',
          [shifts(rows, 'Mollie', b) for b in ('3-4', '4-5', '5-6')],
          [['Bball 3:15p-4p'], ['Gym'], []])
    check('a class sits in the block its hours start in here too',
          [shifts(rows, 'Mattea', b) for b in ('3-4', '4-5', '5-6')],
          [['Bball 3:15p-4p'], ['Crafting 4p-4:45p'], []])
    check('THE INVERSION AGREES WITH THE GRID',
          sorted(p['name'] for p in rows['people']
                 if any(e['kind'] == 'room' and e['label'] == 'Ocean Room'
                        for e in p['blocks']['3-4'])),
          sorted(slot_staff(rows, '3-4', room='Ocean Room')))
    check('a weekday nobody has been given yet still lists everyone, empty',
          [(p['name'], p['blocks']['3-4'], p['gaps'])
           for p in board('?day=Tuesday')['people'] if p['name'] == 'Mollie'],
          [('Mollie', [], [])])
    check('and this schedule has nobody in two places and nobody with a hole',
          rows['staff_warnings'], [])

    # A shift on a class whose hours are still empty has no column to sit in.
    # Listed apart rather than dropped, and — since it cannot be placed in time
    # — it must not invent a hole either side of itself.
    chess = to_class('Chess', 'Lila').get_json()
    parked = board()
    check('a shift on an hours-less class is listed apart',
          [e['label'] for e in person(parked, 'Lila')['unscheduled']], ['Chess'])
    check('and does not put Lila in any hour',
          [shifts(parked, 'Lila', b) for b in ('3-4', '4-5', '5-6')],
          [['Ocean Room'], [], []])
    check('nor does it invent a hole around itself',
          parked['staff_warnings'], [])
    client.delete(f"/api/admin/staff-assignments/{chess['id']}", headers=auth)

    # ── Two places at once, and an hour nobody gave somebody ──────────────
    # Neither is refused: a 409 would block whatever legitimate afternoon nobody
    # thought of, and both of these are undone in one click.
    clash = to_room('Gym', '3-4', 'Fischer').get_json()
    check('putting Fischer in the Gym while he runs Bball is allowed',
          'id' in clash, True)
    check('BUT IT IS REPORTED, WITH BOTH PLACES NAMED',
          [(w['code'], w['label'], w['time_block'], sorted(w['places']))
           for w in board()['staff_warnings']],
          [('staff_overlap', 'Fischer', '3-4',
            sorted(['Bball 3:15p-4p', 'Gym']))])
    check('and the row itself carries it, so the cell can be marked',
          [o['time_block'] for o in person(board(), 'Fischer')['overlaps']],
          ['3-4'])
    client.delete(f"/api/admin/staff-assignments/{clash['id']}", headers=auth)
    check('removing one of the two clears the report',
          board()['staff_warnings'], [])

    # Mollie already runs Bball at 3-4 and the Gym at 4-5 and is NOT reported:
    # consecutive is not simultaneous. A hole is the other shape.
    hole = to_room('Ocean Room', '5-6', 'Katelyn').get_json()
    check('AN HOUR NOBODY GAVE SOMEBODY ALREADY HERE IS REPORTED',
          [(w['code'], w['label'], w['time_block'])
           for w in board()['staff_warnings']],
          [('staff_gap', 'Katelyn', '4-5')])
    check('and the row names the block, so the empty cell can be marked',
          person(board(), 'Katelyn')['gaps'], ['4-5'])
    client.delete(f"/api/admin/staff-assignments/{hole['id']}", headers=auth)
    check('and going home after the hour you were given is not a hole',
          board()['staff_warnings'], [])

    # ── Property 2: moving a grade range leaves the staff standing ─────────
    rule = next(r for r in client.get('/api/admin/care-rules?day=Monday',
                                      headers=auth).get_json()['rules']
                if r['time_block'] == '3-4' and r['grade_min'] == 1)
    moved = client.put(f"/api/admin/care-rules/{rule['id']}",
                       json={'grade_min': 2}, headers=auth)
    check('the Gym 1-4 range narrows to 2-4', moved.status_code, 200)
    after = board()
    check('THE STAFF DID NOT MOVE WITH IT',
          slot_staff(after, '4-5', room='Gym'), ['Mollie'])
    check('and Ocean 3-4 still has its three',
          slot_staff(after, '3-4', room='Ocean Room'),
          ['Katelyn', 'LaRae', 'Lila'])
    check('the grade label followed the rule, though',
          [(r['room_name'], r['grade_label'])
           for r in after['blocks'][0]['rooms']],
          [('Ocean Room', 'K'), ('Gym', '2-4')])
    # Put it back so the rest of the test reads against the photo.
    client.put(f"/api/admin/care-rules/{rule['id']}", json={'grade_min': 1},
               headers=auth)

    # ── Property 3: the CHECKs of sql/37 ─────────────────────────────────
    check('a class shift and a room shift on one row is refused',
          put({'counselor_id': people['Lila'], 'day_of_week': 'Monday',
               'class_session_id': classes['Bball 3:15p-4p'],
               'room_id': rooms['Gym'], 'time_block': '3-4'}).status_code, 400)
    check('a row with neither target is refused',
          put({'counselor_id': people['Lila'],
               'day_of_week': 'Monday'}).status_code, 400)
    check('a weekday AND a date on one row is refused',
          put({'counselor_id': people['Lila'], 'day_of_week': 'Monday',
               'assignment_date': '2026-08-10',
               'room_id': rooms['Gym'], 'time_block': '3-4'}).status_code, 400)
    check('neither a weekday nor a date is refused',
          put({'counselor_id': people['Lila'], 'room_id': rooms['Gym'],
               'time_block': '3-4'}).status_code, 400)
    check('A CARE ROOM SHIFT WITHOUT AN HOUR IS NOT A SHIFT',
          put({'counselor_id': people['Lila'], 'day_of_week': 'Monday',
               'room_id': rooms['Gym']}).status_code, 400)
    check('an unknown block is refused',
          to_room('Gym', '6-7', 'Lila').status_code, 400)
    check("'removed' against the weekly pattern is refused",
          to_room('Playground', '3-4', 'Lila', status='removed').status_code, 400)
    check('a weekend date is refused',
          put({'counselor_id': people['Lila'], 'assignment_date': '2026-08-08',
               'room_id': rooms['Gym'], 'time_block': '3-4'}).status_code, 400)
    # A class carries its own hours, so a block on that row could disagree with
    # them. It is dropped rather than refused: the client has no reason to send
    # one and no reason to care that it did.
    with_block = to_class('Swim L1/2 3p-3:30p', 'Lila', time_block='5-6')
    check('a block sent with a class assignment is dropped, not stored',
          (with_block.status_code, with_block.get_json()['time_block']),
          (201, None))

    # ── Property 4: the uniques dedupe, which PER_ORG_UNIQUES could not ──
    check('THE SAME PERSON TWICE IN THE SAME ROOM SHIFT IS REFUSED',
          to_room('Ocean Room', '3-4', 'Katelyn').status_code, 409)
    check('the same person twice in the same class is refused',
          to_class('Bball 3:15p-4p', 'Fischer').status_code, 409)
    check('but the same person in the NEXT block of the same room is fine',
          to_room('Ocean Room', '4-5', 'Katelyn').status_code, 201)
    check('and on another weekday is fine too',
          to_room('Ocean Room', '3-4', 'Katelyn',
                  day='Tuesday').status_code, 201)
    check('and for one date, alongside the weekly pattern',
          put({'counselor_id': people['Katelyn'],
               'assignment_date': '2026-08-10', 'room_id': rooms['Ocean Room'],
               'time_block': '3-4'}).status_code, 201)
    check('though not that same date twice',
          put({'counselor_id': people['Katelyn'],
               'assignment_date': '2026-08-10', 'room_id': rooms['Ocean Room'],
               'time_block': '3-4'}).status_code, 409)

    # ── Who can be given a shift ─────────────────────────────────────────
    check('a parent cannot be put on the schedule',
          to_room('Gym', '5-6', parent).status_code, 400)
    check('somebody who does not exist cannot either',
          to_room('Gym', '5-6', 999999).status_code, 400)
    check('an archived room cannot be staffed',
          to_room('Playground', '5-6', 'Lila').status_code, 201)
    pin(cur, org)
    cur.execute("UPDATE rooms SET active = FALSE WHERE id = %s",
                (rooms['Playground'],))
    check('once archived, no new shift can point at it',
          to_room('Playground', '4-5', 'Lila').status_code, 400)
    cur.execute("UPDATE rooms SET active = TRUE WHERE id = %s",
                (rooms['Playground'],))
    # The class owns its weekday, and the table cannot see the contradiction.
    check('A MONDAY CLASS CANNOT BE STAFFED ON WEDNESDAY',
          to_class('Bball 3:15p-4p', 'Lila', day='Wednesday').status_code, 400)

    # ── Property 5: the cascades that must not fire ──────────────────────
    check('a room with staff on it cannot be deleted',
          client.delete(f"/api/admin/rooms/{rooms['Gym']}",
                        headers=auth).status_code, 409)
    check('and the refusal counts the shifts, not only the care rules',
          client.delete(f"/api/admin/rooms/{rooms['Gym']}",
                        headers=auth).get_json()['staff_count'] > 0, True)
    check('a class with staff on it cannot be deleted either',
          client.delete(f"/api/admin/class-sessions/{classes['Bball 3:15p-4p']}",
                        headers=auth).status_code, 409)
    check('and that refusal counts the shifts as well as the children',
          client.delete(f"/api/admin/class-sessions/{classes['Bball 3:15p-4p']}",
                        headers=auth).get_json()['staff_count'], 3)
    # Chess has nobody on it and nobody in it, so it is still a typo that can go.
    check('a class with neither staff nor children still deletes',
          client.delete(f"/api/admin/class-sessions/{classes['Chess']}",
                        headers=auth).status_code, 200)

    # ── Removing someone, and what survives it ───────────────────────────
    ocean = next(r for r in board()['blocks'][0]['rooms']
                 if r['room_name'] == 'Ocean Room')
    katelyn = next(p for p in ocean['staff'] if p['counselor_name'] == 'Katelyn')
    check('a shift can be deleted',
          client.delete(
              f"/api/admin/staff-assignments/{katelyn['assignment_id']}",
              headers=auth).status_code, 200)
    check('AND HER COLLEAGUES ARE STILL THERE',
          slot_staff(board(), '3-4', room='Ocean Room'), ['LaRae', 'Lila'])
    check('deleting it twice is a 404',
          client.delete(
              f"/api/admin/staff-assignments/{katelyn['assignment_id']}",
              headers=auth).status_code, 404)

    # ── A date resolves the pattern plus that date's overrides (R8) ───────
    # Piece 7 builds the screen for this; the endpoint answers it already.
    laraes = next(p for p in slot_staff_rows(board(), '3-4', 'Ocean Room')
                  if p['counselor_name'] == 'LaRae')
    check('a removed row for one date takes one person out',
          put({'counselor_id': laraes['counselor_id'],
               'assignment_date': '2026-08-17', 'room_id': rooms['Ocean Room'],
               'time_block': '3-4', 'status': 'removed'}).status_code, 201)
    check('THAT DATE LOSES HER',
          slot_staff(board('?date=2026-08-17'), '3-4', room='Ocean Room'),
          ['Lila'])
    check('AND LEAVES THE COLLEAGUE THE PATTERN PUT THERE',
          slot_staff(board(), '3-4', room='Ocean Room'), ['LaRae', 'Lila'])
    check('a cover for that date is added on top',
          put({'counselor_id': people['Fischer'],
               'assignment_date': '2026-08-17', 'room_id': rooms['Ocean Room'],
               'time_block': '3-4'}).status_code, 201)
    check('and shows up marked as just for today',
          [(p['counselor_name'], p['only_today'])
           for p in slot_staff_rows(board('?date=2026-08-17'), '3-4',
                                    'Ocean Room')],
          [('Fischer', True), ('Lila', False)])
    check('the weekly pattern is still untouched',
          slot_staff(board(), '3-4', room='Ocean Room'), ['LaRae', 'Lila'])
    check('a weekend date is refused on read too',
          client.get('/api/admin/staff-assignments?date=2026-08-15',
                     headers=auth).status_code, 400)

    # The person who was stood down is REPORTED, not merely absent from the
    # resolved list. Without that there is no way back: standing someone down is
    # done in a hurry, and a resolved list that simply lacks them makes an
    # accidental removal unfixable from the screen that made it.
    def ocean_on(date):
        board_ = board(f'?date={date}')
        found = next(b for b in board_['blocks'] if b['time_block'] == '3-4')
        return next(r for r in found['rooms'] if r['room_name'] == 'Ocean Room')

    check('THE STOOD-DOWN PERSON IS REPORTED SO SHE CAN BE PUT BACK',
          [p['counselor_name'] for p in ocean_on('2026-08-17')['out_today']],
          ['LaRae'])
    check('the weekly pattern reports nobody stood down',
          [r['out_today'] for b in board()['blocks'] for r in b['rooms']],
          [[], [], [], [], []])

    # Putting her back is deleting the 'removed' row, and it must restore her
    # without disturbing the cover who was added alongside.
    laraes_removal = ocean_on('2026-08-17')['out_today'][0]
    check('deleting the not-today row puts her back',
          client.delete(
              f"/api/admin/staff-assignments/{laraes_removal['assignment_id']}",
              headers=auth).status_code, 200)
    check('AND THE COVER STAYS ON TOP OF HER',
          slot_staff(board('?date=2026-08-17'), '3-4', room='Ocean Room'),
          ['Fischer', 'LaRae', 'Lila'])
    check('with nobody left stood down',
          ocean_on('2026-08-17')['out_today'], [])
    check('and the weekly pattern never moved through any of it',
          slot_staff(board(), '3-4', room='Ocean Room'), ['LaRae', 'Lila'])

    # ── Property 6: the other JCC ────────────────────────────────────────
    check('THE OTHER JCC SEES NO SHIFTS',
          [p for b in board(headers=other_auth)['blocks']
           for s in (b['rooms'] + b['classes']) for p in s['staff']], [])
    check('and none of these counselors in its pickers',
          board(headers=other_auth)['counselors'], [])
    check('it cannot point a shift at this JCC\'s room',
          put({'counselor_id': people['Lila'], 'day_of_week': 'Monday',
               'room_id': rooms['Gym'], 'time_block': '3-4'},
              headers=other_auth).status_code, 400)
    mine = next(p for b in board()['blocks'] for s in b['rooms']
                for p in s['staff'])
    check('nor delete one of its shifts',
          client.delete(f"/api/admin/staff-assignments/{mine['assignment_id']}",
                        headers=other_auth).status_code, 404)

    # ── Cleanup ──────────────────────────────────────────────────────────
    for scope in (org, other):
        wipe(cur, scope)
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM organizations WHERE slug IN "
                "('t-staff', 't-staff-other', 't-staff-dark')")
    check('cleanup removes the test organizations', cur.rowcount, 3)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All staff assignment checks passed.')
    return 0


def slot_staff_rows(data, block, room):
    """The full staff rows of one room slot, not just the names."""
    found = next(b for b in data['blocks'] if b['time_block'] == block)
    return next(r for r in found['rooms'] if r['room_name'] == room)['staff']


if __name__ == '__main__':
    sys.exit(main())
