"""Tests for the care rules — which grade waits in which room (`daily_ops`).

The parenthesised text in the Care sheet's headers: `Ocean Room (K)`,
`Gym (1-4)`. `care_assignment_rules` has existed since sql/29 with no way in;
these are its endpoints.

THE FIVE THAT MATTER:

  1. The photo's headers come back out. Load the five rules the June workbook's
     headers describe and the endpoint has to reproduce those headers, labels
     and all. This is the check that says the feature works.

  2. A grade with no rule is reported, never absorbed. It means a child the
     routing engine has nowhere to send, so folding it silently into the room
     next door is the one unacceptable answer — the parent would be standing
     somewhere else.

  3. The precedence is total, so the same day always resolves the same way.
     Nothing stops two identical rules existing (no unique on the table), and
     without a tie-break past `priority` the room would change between two
     requests with nobody having edited anything.

  4. A rule cannot point at an archived room. That room's name is what a
     counselor reads as the destination; an archived one prints as a blank.

  5. The other JCC sees none of it, and only an admin sees any of it.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://owner@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_daily_ops_care.py
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

#: The five rules the Care sheet's headers describe, as whole-week rules:
#: (block, grade_min, grade_max, room key).
PHOTO_RULES = [
    ('3-4', 0, 0, 'Ocean Room'),
    ('3-4', 1, 4, 'Gym'),
    ('4-5', 0, 1, 'Ocean Room'),
    ('4-5', 2, 4, 'Gym'),
    ('5-6', 0, 4, 'Ocean Room'),
]

#: What those five rules have to add up to, block by block.
PHOTO_HEADERS = [
    ('3-4', [('Ocean Room', 'K'), ('Gym', '1-4')]),
    ('4-5', [('Ocean Room', 'K-1'), ('Gym', '2-4')]),
    ('5-6', [('Ocean Room', 'K-4')]),
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
    for table in ('care_assignment_rules', 'rooms', 'registrations',
                  'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))


def seed_rooms(cur, org, names):
    pin(cur, org)
    ids = {}
    for order, name in enumerate(names):
        cur.execute("INSERT INTO rooms (name, sort_order) VALUES (%s, %s) "
                    "RETURNING id", (name, order))
        ids[name] = cur.fetchone()['id']
    return ids


def seed_children(cur, org, roster):
    """roster: (grade_label, grade_num, [(weekday, dismissal_hour)]) per child."""
    pin(cur, org)
    cur.execute("INSERT INTO schools (name) VALUES ('Brown') RETURNING id")
    school = cur.fetchone()['id']
    cur.execute("INSERT INTO users (email, password_hash, role, name) "
                "VALUES (%s, 'x', 'parent', 'A Parent') RETURNING id",
                (f'care-parent-{org}@example.com',))
    parent = cur.fetchone()['id']
    for index, (label, num, days) in enumerate(roster):
        cur.execute(
            "INSERT INTO children (name, parent_id, school_id, grade_label, "
            "  grade_num) VALUES (%s, %s, %s, %s, %s) RETURNING id",
            (f'Child {index}', parent, school, label, num))
        cid = cur.fetchone()['id']
        for day, hour in days:
            cur.execute("INSERT INTO registrations (child_id, day_of_week, "
                        "  dismissal_time) VALUES (%s, %s, %s)", (cid, day, hour))
    return school


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    org = make_org(cur, 't-care', 'Care JCC', MODULES)
    other = make_org(cur, 't-care-other', 'Other JCC', MODULES)
    dark = make_org(cur, 't-care-dark', 'No Daily Ops JCC', MODULES_OFF)
    wipe(cur, org)
    wipe(cur, other)

    auth = {'Authorization': f'Bearer {token(org)}'}
    other_auth = {'Authorization': f'Bearer {token(other)}'}

    rooms = seed_rooms(cur, org, ['Ocean Room', 'Gym', 'Playground'])
    # One child per grade K-4 on Monday, and two in second grade so a headcount
    # that counted rules instead of children would show.
    seed_children(cur, org, [
        ('K', 0, [('Monday', 3)]),
        ('1', 1, [('Monday', 4)]),
        ('2', 2, [('Monday', 5)]),
        ('2', 2, [('Monday', 5)]),
        ('3', 3, [('Monday', 6)]),
        ('4', 4, [('Monday', 4)]),
        # Tuesday only: must not be counted in Monday's headcount.
        ('4', 4, [('Tuesday', 4)]),
    ])

    def board(query='?day=Monday', headers=auth):
        return client.get(f'/api/admin/care-rules{query}',
                          headers=headers).get_json()

    def add(block, lo, hi, room, day=None, priority=None, headers=auth):
        body = {'time_block': block, 'grade_min': lo, 'grade_max': hi,
                'room_id': rooms[room] if isinstance(room, str) else room,
                'day_of_week': day}
        if priority is not None:
            body['priority'] = priority
        return client.post('/api/admin/care-rules', json=body, headers=headers)

    # ── The module gate and the roles ─────────────────────────────────────
    dark_auth = {'Authorization': f'Bearer {token(dark)}'}
    check('the rules are refused when daily_ops is off',
          client.get('/api/admin/care-rules', headers=dark_auth).status_code, 403)
    for role in ('counselor', 'parent'):
        headers = {'Authorization': f'Bearer {token(org, role=role)}'}
        check(f'a {role} cannot read the rules',
              client.get('/api/admin/care-rules', headers=headers).status_code, 403)
        check(f'a {role} cannot write one',
              add('3-4', 0, 4, 'Gym', headers=headers).status_code, 403)

    # ── An empty program says so, rather than guessing ────────────────────
    empty = board()
    check('with no rules, no block has a room',
          [len(b['segments']) for b in empty['blocks']], [0, 0, 0])
    check('and every grade in the roster is reported uncovered',
          empty['blocks'][0]['uncovered'], [0, 1, 2, 3, 4])
    check('the grades are the roster\'s, not a hardcoded K-4',
          [g['grade_label'] for g in empty['grades']], ['K', '1', '2', '3', '4'])
    check('a weekend is not a weekday here',
          client.get('/api/admin/care-rules?day=Saturday',
                     headers=auth).status_code, 400)
    check('the default day is Monday', board('')['day'], 'Monday')

    # ── Property 1: the photo's headers, rebuilt ──────────────────────────
    for block, lo, hi, room in PHOTO_RULES:
        check(f'the sheet\'s {room} ({lo}-{hi}) rule is accepted in {block}',
              add(block, lo, hi, room).status_code, 201)

    loaded = board()
    check('THE CARE SHEET\'S OWN HEADERS COME BACK OUT',
          [(b['time_block'],
            [(s['room_name'], s['grade_label']) for s in b['segments']])
           for b in loaded['blocks']],
          PHOTO_HEADERS)
    check('and no grade is left without a room',
          [b['uncovered'] for b in loaded['blocks']], [[], [], []])

    # The headcount: children registered that weekday whose grade lands there.
    check('the 3p-4p headcount splits K from 1-4',
          [s['headcount'] for s in loaded['blocks'][0]['segments']], [1, 5])
    check('and Tuesday\'s child is not in Monday\'s count',
          sum(s['headcount'] for s in loaded['blocks'][0]['segments']), 6)
    check('Tuesday counts only Tuesday',
          [g['children'] for g in board('?day=Tuesday')['grades']
           if g['grade'] == 4], [1])

    # The matrix is the same answer, grade by grade.
    monday_34 = next(m for m in loaded['matrix'] if m['time_block'] == '3-4')
    check('grade by grade, 3p-4p puts K in Ocean and the rest in the Gym',
          [(c['grade_label'], c['room_name']) for c in monday_34['cells']],
          [('K', 'Ocean Room'), ('1', 'Gym'), ('2', 'Gym'), ('3', 'Gym'),
           ('4', 'Gym')])
    check('nothing is overruled when the rules do not overlap',
          [c['overruled'] for c in monday_34['cells']], [[], [], [], [], []])

    # ── Property 2: a grade with no rule is named, not absorbed ───────────
    pin(cur, org)
    cur.execute(
        "INSERT INTO children (name, parent_id, school_id, grade_label, grade_num)"
        " SELECT 'Fifth Grader', parent_id, school_id, '5', 5 FROM children LIMIT 1"
        " RETURNING id")
    fifth = cur.fetchone()['id']
    cur.execute("INSERT INTO registrations (child_id, day_of_week, dismissal_time)"
                " VALUES (%s, 'Monday', 4)", (fifth,))
    with_fifth = board()
    check('the fifth grader with no rule is reported in every block',
          [b['uncovered'] for b in with_fifth['blocks']], [[5], [5], [5]])
    check('AND IS NOT FOLDED INTO THE ROOM NEXT DOOR',
          [(s['room_name'], s['grade_label'])
           for s in with_fifth['blocks'][2]['segments']],
          [('Ocean Room', 'K-4')])
    check('their room reads as nowhere, not as a blank',
          [c['room_name'] for c in
           next(m for m in with_fifth['matrix'] if m['time_block'] == '5-6')['cells']
           if c['grade'] == 5], [None])
    cur.execute("DELETE FROM children WHERE id = %s", (fifth,))

    # A child with no grade at all cannot be reached by any rule, and the
    # endpoint says how many rather than dropping them.
    cur.execute(
        "INSERT INTO children (name, parent_id, school_id)"
        " SELECT 'No Grade', parent_id, school_id FROM children LIMIT 1"
        " RETURNING id")
    ungraded = cur.fetchone()['id']
    cur.execute("INSERT INTO registrations (child_id, day_of_week) "
                "VALUES (%s, 'Monday')", (ungraded,))
    check('a child with no grade is counted, not silently dropped',
          board()['ungraded_children'], 1)
    cur.execute("DELETE FROM children WHERE id = %s", (ungraded,))

    # ── Property 3: the precedence, and that it is total ──────────────────
    # A Wednesday-only rule sits on top of the standard week without deleting it.
    check('a Wednesday-only rule is accepted',
          add('3-4', 0, 4, 'Playground', day='Wednesday').status_code, 201)
    check('Wednesday follows its own rule',
          [(s['room_name'], s['grade_label'])
           for s in board('?day=Wednesday')['blocks'][0]['segments']],
          [('Playground', 'K-4')])
    check('AND MONDAY IS UNTOUCHED BY IT',
          [(s['room_name'], s['grade_label'])
           for s in board()['blocks'][0]['segments']],
          [('Ocean Room', 'K'), ('Gym', '1-4')])
    wed_34 = next(m for m in board('?day=Wednesday')['matrix']
                  if m['time_block'] == '3-4')
    check('and the rules it beat are named, so the overlap is visible',
          [len(c['overruled']) for c in wed_34['cells']], [1, 1, 1, 1, 1])

    # Two rules that differ only in room: the narrower range has to win, and it
    # has to keep winning across requests.
    check('a narrow rule on top of a wide one is accepted',
          add('5-6', 2, 2, 'Playground').status_code, 201)
    resolved = [board()['blocks'][2]['segments'] for _ in range(3)]
    check('the narrower range wins',
          [(s['room_name'], s['grade_label']) for s in resolved[0]],
          [('Ocean Room', 'K-1'), ('Playground', '2'), ('Ocean Room', '3-4')])
    check('AND THE SAME DAY RESOLVES THE SAME WAY EVERY TIME',
          [[(s['room_name'], s['grade_label']) for s in r] for r in resolved[1:]],
          [[(s['room_name'], s['grade_label']) for s in resolved[0]]] * 2)

    # Two rules for the same range and block, differing only in priority.
    check('a lower priority is accepted alongside',
          add('5-6', 3, 4, 'Gym', priority=10).status_code, 201)
    check('the lower priority wins the tie',
          [(s['room_name'], s['grade_label'])
           for s in board()['blocks'][2]['segments']],
          [('Ocean Room', 'K-1'), ('Playground', '2'), ('Gym', '3-4')])

    # ── The duplicate the table has no unique for ─────────────────────────
    check('the exact same rule twice is refused',
          add('3-4', 1, 4, 'Gym').status_code, 409)
    check('but the same range in another room is a real choice',
          add('3-4', 1, 4, 'Playground', priority=5).status_code, 201)

    # ── Property 4: the room has to be one a counselor could read ─────────
    pin(cur, org)
    cur.execute("UPDATE rooms SET active = FALSE WHERE id = %s",
                (rooms['Playground'],))
    check('a rule cannot point at an archived room',
          add('4-5', 0, 4, 'Playground').status_code, 400)
    check('and the refusal explains it, rather than 404ing on a real id',
          'archived' in add('4-5', 0, 4, 'Playground').get_json()['error'], True)
    cur.execute("UPDATE rooms SET active = TRUE WHERE id = %s",
                (rooms['Playground'],))
    check('a room that does not exist is refused too',
          add('4-5', 0, 4, 999999).status_code, 400)

    # ── The rest of the validation ────────────────────────────────────────
    check('a backwards grade range is refused',
          add('3-4', 4, 1, 'Gym').status_code, 400)
    check('an unknown block is refused',
          add('6-7', 0, 4, 'Gym').status_code, 400)
    check('a grade above 12 is refused',
          add('3-4', 0, 13, 'Gym').status_code, 400)
    check('a weekend rule is refused',
          add('3-4', 0, 4, 'Gym', day='Saturday').status_code, 400)

    # ── Editing and deleting ──────────────────────────────────────────────
    rules = board()['rules']
    kinder = next(r for r in rules
                  if r['time_block'] == '3-4' and r['grade_max'] == 0)
    moved = client.put(f"/api/admin/care-rules/{kinder['id']}",
                       json={'grade_max': 1}, headers=auth)
    check('a range can be widened', moved.status_code, 200)
    # Ocean now covers K-1, so grade 1 moves out of the 1-4 rules. Of those two,
    # the Playground rule added above at priority 5 beats the Gym's default 100 —
    # the precedence still applying after an edit, not a stale read.
    check('and the header follows it',
          [(s['room_name'], s['grade_label'])
           for s in board()['blocks'][0]['segments']],
          [('Ocean Room', 'K-1'), ('Playground', '2-4')])
    check('a partial edit leaves the room alone',
          moved.get_json()['room_id'], rooms['Ocean Room'])
    check('editing an unknown rule is a 404',
          client.put('/api/admin/care-rules/999999', json={'grade_max': 2},
                     headers=auth).status_code, 404)

    # Unlike rooms and classes, this really deletes: nothing points at a rule.
    check('a rule can be deleted outright',
          client.delete(f"/api/admin/care-rules/{kinder['id']}",
                        headers=auth).status_code, 200)
    check('and it is gone',
          [r['id'] for r in board()['rules'] if r['id'] == kinder['id']], [])
    check('deleting it twice is a 404',
          client.delete(f"/api/admin/care-rules/{kinder['id']}",
                        headers=auth).status_code, 404)

    # ── Property 5: the other JCC ─────────────────────────────────────────
    check('THE OTHER JCC SEES NONE OF THESE RULES',
          board(headers=other_auth)['rules'], [])
    check('and none of these rooms',
          [s for b in board(headers=other_auth)['blocks'] for s in b['segments']],
          [])
    check('and cannot edit one of them',
          client.put(f"/api/admin/care-rules/{rules[0]['id']}",
                     json={'grade_max': 4}, headers=other_auth).status_code, 404)
    check('nor delete one',
          client.delete(f"/api/admin/care-rules/{rules[0]['id']}",
                        headers=other_auth).status_code, 404)
    check('nor point a rule at this JCC\'s room',
          add('3-4', 0, 4, 'Gym', headers=other_auth).status_code, 400)

    # ── Cleanup ──────────────────────────────────────────────────────────
    # The organizations too, not just their rows: three sibling tests assert
    # that no 't-%' organization survives, so leaving these behind fails them
    # instead of this one.
    for scope in (org, other):
        wipe(cur, scope)
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM organizations WHERE slug IN "
                "('t-care', 't-care-other', 't-care-dark')")
    check('cleanup removes the test organizations', cur.rowcount, 3)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All care rule checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
