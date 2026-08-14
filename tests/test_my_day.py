"""Tests for the counselor's own afternoon — /api/counselor/my-day (daily_ops).

This is what replaces the marker. Today the director prints all four sheets for
every counselor and highlights each person's blocks by hand (R9), so everyone
carries three pages of somebody else's assignments to find their own.

THE SIX THAT MATTER:

  1. A COUNSELOR SEES ONLY THEIR OWN DAY. The filter is the counselor_id in the
     token and there is no parameter that can change it. Two counselors on the
     same afternoon must get two different answers.

  2. It is the same answer as the engine's, not a second derivation. `Dismiss To`
     here has to match what tests/test_daily_routing.py asserts for the same
     Monday: the chained class, then PARENTS, then the care room.

  3. Blocks come back in the order the afternoon happens, because that is the
     only order in which the screen is useful while standing up.

  4. The bold of the Care sheet survives the trip. A child pulled out by a class
     is marked, one whose class is in the next block is not.

  5. An absent child is marked, not dropped, and not counted. Dropping them
     leaves a counselor looking for a child who is at home; counting them makes
     the headcount lie.

  6. Nothing invents a destination. A child with no pickup time comes back
     'unknown' with a warning, never PARENTS at six.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://owner@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_my_day.py
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

#: A Monday, 2026-08-10, and the Saturday after it.
MONDAY = '2026-08-10'
SATURDAY = '2026-08-15'

CLASSES = [
    ('Bball 3:15p-4p', 'Monday', '15:15', '16:00', 'Courts'),
    ('Crafting 4p-4:45p', 'Monday', '16:00', '16:45', 'WKL'),
    ('Swim L1/2 3p-3:30p', 'Monday', '15:00', '15:30', 'Pool'),
    ('Mini Masters 4p-4:45p', 'Monday', '16:00', '16:45', 'MPR'),
]

CARE_RULES = [
    ('3-4', 0, 0, 'Ocean Room'),
    ('3-4', 1, 4, 'Gym'),
    ('4-5', 0, 1, 'Ocean Room'),
    ('4-5', 2, 4, 'Gym'),
    ('5-6', 0, 4, 'Ocean Room'),
]

#: (name, grade_label, grade_num, dismissal hour, allergies, [class names])
CHILDREN = [
    # K, swims 3:00-3:30 then waits in Ocean until four. Bold in Ocean 3-4.
    ('Beau Farden', 'K', 0, 4, 'Peanut (EpiPen)', ['Swim L1/2 3p-3:30p']),
    # K, class is in the NEXT block, so 3-4 is a full hour and not bold.
    ('Grant Hoskins', 'K', 0, 5, None, ['Mini Masters 4p-4:45p']),
    # 2nd grade, Bball chained into Crafting, out at six.
    ('Cara Diaz', '2', 2, 6, None, ['Bball 3:15p-4p', 'Crafting 4p-4:45p']),
    # 2nd grade, Bball ends exactly at their four o'clock pickup → PARENTS.
    ('Dan Ebner', '2', 2, 4, 'Dairy', ['Bball 3:15p-4p']),
    # No pickup hour at all: must come back unknown, never six.
    ('Nora Vance', '1', 1, None, None, ['Bball 3:15p-4p']),
    # Nobody's class; pure care, and the one reported absent. K so she lands in
    # Ocean with the two bold cases rather than in the Gym.
    ('Absent Amy', 'K', 0, 5, None, []),
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


def token(org_id, role='counselor', user_id='1'):
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
    for name in ('Katelyn', 'Mollie', 'Fischer'):
        cur.execute(
            "INSERT INTO users (email, password_hash, role, name) "
            "VALUES (%s, 'x', 'counselor', %s) RETURNING id",
            (f'{name.lower()}-myday-{org}@example.com', name))
        people[name] = cur.fetchone()['id']
    cur.execute(
        "INSERT INTO users (email, password_hash, role, name) "
        "VALUES (%s, 'x', 'parent', 'A Parent') RETURNING id",
        (f'myday-parent-{org}@example.com',))
    parent = cur.fetchone()['id']

    cur.execute("INSERT INTO schools (name) VALUES ('Brown') RETURNING id")
    school = cur.fetchone()['id']
    kids = {}
    for name, label, num, hour, allergies, in_classes in CHILDREN:
        cur.execute(
            "INSERT INTO children (name, parent_id, school_id, grade_label, "
            "  grade_num, allergies) VALUES (%s, %s, %s, %s, %s, %s) RETURNING id",
            (name, parent, school, label, num, allergies))
        kids[name] = cur.fetchone()['id']
        cur.execute("INSERT INTO registrations (child_id, day_of_week, "
                    "  dismissal_time) VALUES (%s, 'Monday', %s)",
                    (kids[name], hour))
        for class_name in in_classes:
            cur.execute("INSERT INTO class_enrollments (child_id, "
                        "  class_session_id) VALUES (%s, %s)",
                        (kids[name], classes[class_name]))

    cur.execute("INSERT INTO absences (child_id, absence_date) VALUES (%s, %s)",
                (kids['Absent Amy'], MONDAY))
    return rooms, classes, people, kids


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    org = make_org(cur, 't-myday', 'My Day JCC', MODULES)
    other = make_org(cur, 't-myday-other', 'Other JCC', MODULES)
    dark = make_org(cur, 't-myday-dark', 'No Daily Ops JCC', MODULES_OFF)
    wipe(cur, org)
    wipe(cur, other)
    rooms, classes, people, kids = seed(cur, org)

    admin_auth = {'Authorization': f'Bearer {token(org, role="admin")}'}

    def as_counselor(name, in_org=org):
        return {'Authorization':
                f'Bearer {token(in_org, user_id=people[name])}'}

    def my_day(name, date=MONDAY, headers=None):
        return client.get(f'/api/counselor/my-day?date={date}',
                          headers=headers or as_counselor(name)).get_json()

    def assign(who, *, class_name=None, room=None, block=None):
        body = {'counselor_id': people[who], 'day_of_week': 'Monday'}
        if class_name:
            body['class_session_id'] = classes[class_name]
        else:
            body['room_id'] = rooms[room]
            body['time_block'] = block
        return client.post('/api/admin/staff-assignments', json=body,
                           headers=admin_auth)

    # ── The gate and the roles ────────────────────────────────────────────
    check('the day is refused when daily_ops is off',
          client.get('/api/counselor/my-day',
                     headers={'Authorization': f'Bearer {token(dark)}'}
                     ).status_code, 403)
    for role in ('admin', 'parent'):
        check(f'a {role} cannot read a counselor day',
              client.get('/api/counselor/my-day',
                         headers={'Authorization': f'Bearer {token(org, role=role)}'}
                         ).status_code, 403)

    # ── Nothing assigned yet ──────────────────────────────────────────────
    check('an unassigned counselor gets an empty day, not an error',
          (my_day('Katelyn')['blocks'], my_day('Katelyn')['closed']), ([], False))
    check('a weekend says the program is closed',
          my_day('Katelyn', SATURDAY)['closed'], True)
    check('and a weekend has no blocks to show',
          my_day('Katelyn', SATURDAY)['blocks'], [])
    check('a date that is not a date is refused',
          client.get('/api/counselor/my-day?date=not-a-date',
                     headers=as_counselor('Katelyn')).status_code, 400)

    # ── Katelyn: Bball, then the Gym from four to five ────────────────────
    check('Bball is assigned', assign('Katelyn',
                                      class_name='Bball 3:15p-4p').status_code, 201)
    check('and the Gym at 4-5',
          assign('Katelyn', room='Gym', block='4-5').status_code, 201)
    # Mollie shares Bball, so she is a colleague on that block.
    check('Mollie shares Bball',
          assign('Mollie', class_name='Bball 3:15p-4p').status_code, 201)
    # Fischer has Ocean 3-4 only — the day Katelyn must not see.
    check('Fischer takes Ocean 3-4',
          assign('Fischer', room='Ocean Room', block='3-4').status_code, 201)

    katelyn = my_day('Katelyn')
    check('BLOCKS COME BACK IN THE ORDER THE AFTERNOON HAPPENS',
          [(b['kind'], b['title'], b['start_time']) for b in katelyn['blocks']],
          [('class', 'Bball 3:15p-4p', '15:15'), ('care', 'Gym', '16:00')])
    check('the colleague in her class is named, and she is not',
          [w['name'] for w in katelyn['blocks'][0]['with']], ['Mollie'])
    check('the care block she has alone lists nobody else',
          katelyn['blocks'][1]['with'], [])

    # ── Property 2: the same Dismiss To the engine's own test asserts ──────
    bball = katelyn['blocks'][0]
    check('BBALL DISMISSES EXACTLY AS THE ENGINE SAYS',
          [(c['name'], c['dismiss_to'], c['dismiss_kind']) for c in bball['children']],
          [('Cara Diaz', 'Crafting 4p-4:45p', 'class'),
           ('Dan Ebner', 'PARENTS', 'parents'),
           ('Nora Vance', None, 'unknown')])
    check('the chained child is the one flagged with her ** convention',
          [c['name'] for c in bball['children'] if c['chained']], ['Cara Diaz'])
    check('every row carries the allergy, which changes what she does',
          [(c['name'], c['allergies']) for c in bball['children']
           if c['allergies']], [('Dan Ebner', 'Dairy')])
    check('and the pickup hour, so she knows who leaves when',
          [(c['name'], c['dismissal_time']) for c in bball['children']],
          [('Cara Diaz', 6), ('Dan Ebner', 4), ('Nora Vance', None)])

    # ── Property 6: nothing is invented ──────────────────────────────────
    check('NO PICKUP TIME COMES BACK UNKNOWN, NOT PARENTS AT SIX',
          [c['dismiss_kind'] for c in bball['children']
           if c['name'] == 'Nora Vance'], ['unknown'])
    check('and it is warned about, on her screen',
          sorted({w['child_name'] for w in katelyn['warnings']}), ['Nora Vance'])

    # ── Property 4 and 5: the Gym at 4-5 ─────────────────────────────────
    gym = katelyn['blocks'][1]
    check('the Gym holds the second grader whose class has let out',
          [(c['name'], c['partial']) for c in gym['children']],
          [('Cara Diaz', True)])
    check('and says which class she came out of',
          [(c['name'], c['from_class']) for c in gym['children']],
          [('Cara Diaz', 'Crafting 4p-4:45p')])
    # Dan is a second grader too and is NOT here: he goes home at four, so the
    # four-to-five block is not his at all. A list that included him would have
    # a counselor waiting for a child whose parent already took them.
    check('A CHILD WHO WENT HOME AT FOUR IS NOT IN THE FOUR-TO-FIVE BLOCK',
          [c['name'] for c in gym['children'] if c['name'] == 'Dan Ebner'], [])

    # Fischer's Ocean 3-4 is where the bold and the absence live.
    fischer = my_day('Fischer')
    ocean = fischer['blocks'][0]
    check('THE CARE SHEET\'S BOLD SURVIVES THE TRIP',
          [(c['name'], c['partial']) for c in ocean['children']
           if c['name'] in ('Beau Farden', 'Grant Hoskins')],
          [('Beau Farden', True), ('Grant Hoskins', False)])
    check('the one pulled out by a class says which',
          [(c['name'], c['from_class'], c['to_class']) for c in ocean['children']
           if c['name'] == 'Beau Farden'],
          [('Beau Farden', 'Swim L1/2 3p-3:30p', None)])
    check('and the one going INTO a class says that instead',
          [(c['name'], c['from_class'], c['to_class']) for c in ocean['children']
           if c['name'] == 'Grant Hoskins'],
          [('Grant Hoskins', None, 'Mini Masters 4p-4:45p')])

    # ── Property 5: absent is marked, kept, and not counted ──────────────
    amy = [c for c in ocean['children'] if c['name'] == 'Absent Amy']
    check('the absent child is still listed, so nobody looks for her',
          [c['absent'] for c in amy], [True])
    check('AND IS NOT IN THE HEADCOUNT',
          ocean['present_count'], len(ocean['children']) - 1)
    check('absent rows sort last, out of the way',
          ocean['children'][-1]['name'], 'Absent Amy')

    # ── Property 1: one counselor never sees another's day ────────────────
    check('KATELYN AND FISCHER GET DIFFERENT AFTERNOONS',
          ([b['title'] for b in katelyn['blocks']],
           [b['title'] for b in fischer['blocks']]),
          (['Bball 3:15p-4p', 'Gym'], ['Ocean Room']))
    check('Mollie sees only the class she shares',
          [b['title'] for b in my_day('Mollie')['blocks']], ['Bball 3:15p-4p'])
    # There is no parameter to change: the filter is the token's own identity.
    check('a counselor id in the query string changes nothing',
          [b['title'] for b in client.get(
              f'/api/counselor/my-day?date={MONDAY}'
              f"&counselor_id={people['Fischer']}",
              headers=as_counselor('Katelyn')).get_json()['blocks']],
          ['Bball 3:15p-4p', 'Gym'])

    # ── The other JCC ────────────────────────────────────────────────────
    # A token from the other organization carrying this one's user id: the id is
    # real, the row is invisible, so the day has to be empty rather than someone
    # else's.
    check('THE OTHER JCC CANNOT READ THIS COUNSELOR\'S DAY',
          my_day('Katelyn', headers={
              'Authorization': f'Bearer {token(other, user_id=people["Katelyn"])}'
          })['blocks'], [])

    # ── An override for one date reaches the counselor's screen (R8) ──────
    check('Fischer is pulled out of Ocean for this Monday only',
          client.post('/api/admin/staff-assignments',
                      json={'counselor_id': people['Fischer'],
                            'assignment_date': MONDAY,
                            'room_id': rooms['Ocean Room'],
                            'time_block': '3-4', 'status': 'removed'},
                      headers=admin_auth).status_code, 201)
    check('so that Monday is empty for him',
          my_day('Fischer')['blocks'], [])
    check('but the following Monday still has him',
          [b['title'] for b in my_day('Fischer', '2026-08-17')['blocks']],
          ['Ocean Room'])

    # ── Cleanup ──────────────────────────────────────────────────────────
    for scope in (org, other):
        wipe(cur, scope)
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM organizations WHERE slug IN "
                "('t-myday', 't-myday-other', 't-myday-dark')")
    check('cleanup removes the test organizations', cur.rowcount, 3)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All my-day checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
