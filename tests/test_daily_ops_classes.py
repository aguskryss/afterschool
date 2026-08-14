"""Tests for the class catalogue (`daily_ops`, §6.1 steps 1-2).

The importer creates a row per (class name, weekday) out of the roster's
M/T/W/R/F columns and leaves `start_time`, `end_time` and `location` NULL,
because the spreadsheet does not carry them. This is the screen that fills them
in, and nothing downstream works until it has been used: `Dismiss To` compares a
class's end against the child's dismissal hour, so a class with no end has no
computable destination.

THE FOUR THAT MATTER:

  1. A guess never overwrites a decision. `apply-time-suggestions` reads hours
     out of a class's own name, and it must only ever fill columns that are
     still NULL. Hours an admin typed are the record; the parser is a
     convenience.

  2. Nothing is suggested in bulk without being asked for. The endpoint takes
     explicit ids, so "fix everything" cannot happen by accident — which is the
     silent default sql/35 deliberately refused to add.

  3. Deleting a class with a roster is refused, not cascaded.
     class_enrollments.class_session_id is ON DELETE CASCADE, so a permitted
     delete would drop those children's enrolments and with them every derived
     view's idea of where they are at that hour.

  4. Renaming warns. roster_staging matches a class by its name against the
     spreadsheet text, so a rename makes the next import recreate the old name
     as a second class and split the enrolments between them.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://owner@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_daily_ops_classes.py
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

# The names really in the June workbook, with their hours inside the text, plus
# the two that carry none. This is what the importer hands over.
AS_IMPORTED = [
    ('Bball 3:15p-4p', 'Monday'),
    ('Crafting 4p-4:45p', 'Monday'),
    ('Mini Masters 4p-4:45p', 'Monday'),
    ('Tinker Titans 3:15p-4p', 'Monday'),
    ('Swim L1/2 3p-3:30p', 'Monday'),
    ('Chess', 'Monday'),
    ('NO CLASS', 'Monday'),
    ('Swim T 3:30p-4:30p', 'Tuesday'),
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
    for table in ('class_enrollments', 'class_sessions', 'registrations',
                  'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))


def seed_as_imported(cur, org):
    """Write class rows exactly the way roster_staging._class_session_id does."""
    pin(cur, org)
    ids = {}
    for name, day in AS_IMPORTED:
        cur.execute("INSERT INTO class_sessions (name, day_of_week) "
                    "VALUES (%s, %s) RETURNING id", (name, day))
        ids[name] = cur.fetchone()['id']
    return ids


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    org = make_org(cur, 't-classes', 'Classes JCC', MODULES)
    other = make_org(cur, 't-classes-other', 'Other JCC', MODULES)
    dark = make_org(cur, 't-classes-dark', 'No Daily Ops JCC', MODULES_OFF)
    wipe(cur, org)
    wipe(cur, other)

    auth = {'Authorization': f'Bearer {token(org)}'}
    other_auth = {'Authorization': f'Bearer {token(other)}'}
    ids = seed_as_imported(cur, org)

    def listing(query='', headers=auth):
        return client.get(f'/api/admin/class-sessions{query}',
                          headers=headers).get_json()

    def by_name(name, rows=None):
        rows = rows if rows is not None else listing()
        return next(r for r in rows if r['name'] == name)

    # ── The module gate and the roles ─────────────────────────────────────
    dark_auth = {'Authorization': f'Bearer {token(dark)}'}
    check('the catalogue is refused when daily_ops is off',
          client.get('/api/admin/class-sessions', headers=dark_auth).status_code, 403)
    for role in ('counselor', 'parent'):
        headers = {'Authorization': f'Bearer {token(org, role=role)}'}
        check(f'a {role} cannot read the catalogue',
              client.get('/api/admin/class-sessions', headers=headers).status_code, 403)
        check(f'a {role} cannot apply time suggestions',
              client.post('/api/admin/class-sessions/apply-time-suggestions',
                          json={'ids': list(ids.values())},
                          headers=headers).status_code, 403)

    # ── What the importer leaves behind ──────────────────────────────────
    rows = listing()
    check('every imported class is listed', len(rows), len(AS_IMPORTED))
    check('AND EVERY ONE OF THEM HAS NO HOURS',
          [r['name'] for r in rows if r['start_time'] or r['end_time']], [])
    check('weekdays sort in week order, not alphabetically',
          [r['day_of_week'] for r in rows][-1], 'Tuesday')
    check('a day filter narrows it',
          {r['day_of_week'] for r in listing('?day=Monday')}, {'Monday'})
    check('a weekend is not a weekday here',
          client.get('/api/admin/class-sessions?day=Saturday',
                     headers=auth).status_code, 400)

    # ── The suggestion, which is only ever a suggestion ──────────────────
    check('hours inside a name are offered',
          (by_name('Bball 3:15p-4p')['suggested_start'],
           by_name('Bball 3:15p-4p')['suggested_end']), ('15:15', '16:00'))
    check('so are the fiddly ones',
          (by_name('Swim L1/2 3p-3:30p')['suggested_start'],
           by_name('Swim L1/2 3p-3:30p')['suggested_end']), ('15:00', '15:30'))
    check('a name with no hours offers nothing',
          by_name('Chess')['suggested_start'], None)
    check('and neither does a legend line',
          by_name('NO CLASS')['suggested_start'], None)

    # Property 2: ids, never "all".
    check('applying with no ids is refused',
          client.post('/api/admin/class-sessions/apply-time-suggestions',
                      json={'ids': []}, headers=auth).status_code, 400)
    check('applying with a non-list is refused',
          client.post('/api/admin/class-sessions/apply-time-suggestions',
                      json={'ids': 'all'}, headers=auth).status_code, 400)

    applied = client.post('/api/admin/class-sessions/apply-time-suggestions',
                          json={'ids': list(ids.values())},
                          headers=auth).get_json()
    check('the six names that carry hours get them', len(applied['applied']), 6)
    check('the two that do not are reported, not silently dropped',
          sorted(s['reason'] for s in applied['skipped']),
          ['no times in the name', 'no times in the name'])
    check('an unknown id is reported too',
          client.post('/api/admin/class-sessions/apply-time-suggestions',
                      json={'ids': [999999]},
                      headers=auth).get_json()['skipped'],
          [{'id': 999999, 'reason': 'unknown'}])
    check('Crafting now ends when the sheet says it does',
          (by_name('Crafting 4p-4:45p')['start_time'],
           by_name('Crafting 4p-4:45p')['end_time']), ('16:00', '16:45'))
    check('a class whose hours are set stops being offered a suggestion',
          by_name('Crafting 4p-4:45p')['suggested_start'], None)

    # ── Property 1: a guess never overwrites a decision ──────────────────
    # Heather corrects Bball to the hours she actually runs, which differ from
    # the ones its name claims. Re-running the suggestion must not undo her.
    client.put(f'/api/admin/class-sessions/{ids["Bball 3:15p-4p"]}',
               json={'start_time': '15:00', 'end_time': '15:45'}, headers=auth)
    again = client.post('/api/admin/class-sessions/apply-time-suggestions',
                        json={'ids': [ids['Bball 3:15p-4p']]},
                        headers=auth).get_json()
    check('re-applying skips a class that already has hours',
          again['skipped'], [{'id': ids['Bball 3:15p-4p'], 'reason': 'already set'}])
    check('AND THE HAND-TYPED HOURS SURVIVE',
          (by_name('Bball 3:15p-4p')['start_time'],
           by_name('Bball 3:15p-4p')['end_time']), ('15:00', '15:45'))

    # ── Editing ──────────────────────────────────────────────────────────
    filled = client.put(f'/api/admin/class-sessions/{ids["Chess"]}',
                        json={'start_time': '16:00', 'end_time': '16:45',
                              'location': 'WKL', 'capacity': 12},
                        headers=auth).get_json()
    check('hours typed by hand land', (filled['start_time'], filled['end_time']),
          ('16:00', '16:45'))
    check('so does the room', filled['location'], 'WKL')
    check('so does the capacity', filled['capacity'], 12)

    partial = client.put(f'/api/admin/class-sessions/{ids["Chess"]}',
                         json={'capacity': 15}, headers=auth).get_json()
    check('a partial edit keeps the hours', partial['end_time'], '16:45')
    check('a partial edit keeps the room', partial['location'], 'WKL')

    check('a backwards class is refused',
          client.put(f'/api/admin/class-sessions/{ids["Chess"]}',
                     json={'start_time': '17:00', 'end_time': '16:00'},
                     headers=auth).status_code, 400)
    check('an unparseable time is refused',
          client.put(f'/api/admin/class-sessions/{ids["Chess"]}',
                     json={'start_time': '4pm'}, headers=auth).status_code, 400)
    check('a zero capacity is refused',
          client.put(f'/api/admin/class-sessions/{ids["Chess"]}',
                     json={'capacity': 0}, headers=auth).status_code, 400)
    check('editing a class that does not exist is a 404',
          client.put('/api/admin/class-sessions/999999',
                     json={'capacity': 3}, headers=auth).status_code, 404)

    # ── Creating one the roster never mentioned ──────────────────────────
    made = client.post('/api/admin/class-sessions',
                       json={'name': 'Pvt Swim', 'day_of_week': 'Wednesday',
                             'start_time': '15:30', 'end_time': '16:00',
                             'location': 'Pool'}, headers=auth)
    check('a class can be added by hand', made.status_code, 201)
    check('a weekend is refused',
          client.post('/api/admin/class-sessions',
                      json={'name': 'Yoga', 'day_of_week': 'Saturday'},
                      headers=auth).status_code, 400)
    check('a missing weekday is refused',
          client.post('/api/admin/class-sessions',
                      json={'name': 'Yoga'}, headers=auth).status_code, 400)
    check('a blank name is refused',
          client.post('/api/admin/class-sessions',
                      json={'name': '  ', 'day_of_week': 'Monday'},
                      headers=auth).status_code, 400)
    check('the same name on the same day is refused',
          client.post('/api/admin/class-sessions',
                      json={'name': 'Chess', 'day_of_week': 'Monday'},
                      headers=auth).status_code, 409)
    # Identity is (name, weekday): the same class on another day is another row,
    # because it can have different hours, a different room and a different
    # roster.
    check('BUT THE SAME NAME ON ANOTHER DAY IS A DIFFERENT CLASS',
          client.post('/api/admin/class-sessions',
                      json={'name': 'Chess', 'day_of_week': 'Wednesday'},
                      headers=auth).status_code, 201)

    # ── Property 4: renaming warns about the next import ─────────────────
    renamed = client.put(f'/api/admin/class-sessions/{ids["Bball 3:15p-4p"]}',
                         json={'name': 'Basketball'}, headers=auth).get_json()
    check('a rename goes through', renamed['name'], 'Basketball')
    check('AND SAYS WHAT THE NEXT IMPORT WILL DO',
          'Bball 3:15p-4p' in (renamed.get('warning') or ''), True)
    check('an edit that is not a rename says nothing',
          'warning' in client.put(
              f'/api/admin/class-sessions/{ids["Bball 3:15p-4p"]}',
              json={'capacity': 9}, headers=auth).get_json(), False)

    # ── Property 3: a class with a roster is not deletable ───────────────
    pin(cur, org)
    cur.execute("INSERT INTO schools (name) VALUES ('Brown') RETURNING id")
    school = cur.fetchone()['id']
    cur.execute("INSERT INTO users (email, password_hash, role, name) "
                "VALUES ('t-classes-parent@example.com', 'x', 'parent', 'A Parent') "
                "RETURNING id")
    parent = cur.fetchone()['id']

    def add_child(name, active, grade):
        cur.execute("INSERT INTO children (name, parent_id, school_id, active, "
                    "grade_num) VALUES (%s, %s, %s, %s, %s) RETURNING id",
                    (name, parent, school, active, grade))
        return cur.fetchone()['id']

    here = add_child('Beau Farden', 1, 0)
    gone = add_child('Withdrawn Kid', 0, 1)
    crafting = ids['Crafting 4p-4:45p']
    for kid in (here, gone):
        cur.execute("INSERT INTO class_enrollments (child_id, class_session_id) "
                    "VALUES (%s, %s)", (kid, crafting))

    # A withdrawn child keeps their enrolment — roster_staging's withdraw branch
    # does not remove it — so the number the screen shows has to exclude them or
    # every class reads as fuller than the room it needs.
    check('enrolled_count counts the children who are still here',
          by_name('Crafting 4p-4:45p')['enrolled_count'], 1)

    refused = client.delete(f'/api/admin/class-sessions/{crafting}', headers=auth)
    check('deleting a class children are enrolled in is refused',
          refused.status_code, 409)
    check('and the refusal counts every enrolment the cascade would destroy',
          refused.get_json()['enrolments'], 2)
    pin(cur, org)
    cur.execute("SELECT COUNT(*) AS n FROM class_enrollments")
    check('SO BOTH ENROLMENTS ARE STILL THERE', cur.fetchone()['n'], 2)

    check('archiving it instead works',
          client.put(f'/api/admin/class-sessions/{crafting}',
                     json={'active': False}, headers=auth).status_code, 200)
    check('an archived class drops off the list',
          'Crafting 4p-4:45p' in [r['name'] for r in listing()], False)
    check('and comes back when asked for',
          'Crafting 4p-4:45p' in
          [r['name'] for r in listing('?include_inactive=1')], True)

    check('a class nobody is enrolled in still deletes',
          client.delete(f'/api/admin/class-sessions/{ids["NO CLASS"]}',
                        headers=auth).status_code, 200)
    check('deleting it twice is a 404',
          client.delete(f'/api/admin/class-sessions/{ids["NO CLASS"]}',
                        headers=auth).status_code, 404)

    # ── Two JCCs, one Monday Chess, no leakage ───────────────────────────
    theirs = client.post('/api/admin/class-sessions',
                         json={'name': 'Chess', 'day_of_week': 'Monday'},
                         headers=other_auth)
    check('another JCC may also run Chess on Monday', theirs.status_code, 201)
    check('and sees only its own catalogue',
          [r['name'] for r in listing(headers=other_auth)], ['Chess'])
    check('ours does not include theirs',
          theirs.get_json()['id'] in [r['id'] for r in listing()], False)
    # RLS hides the row, so the handler's existence check misses and answers 404
    # — which is also the right answer: a 403 would confirm the id is real.
    check('editing another JCC\'s class is a 404',
          client.put(f'/api/admin/class-sessions/{theirs.get_json()["id"]}',
                     json={'capacity': 99}, headers=auth).status_code, 404)
    check('applying suggestions cannot reach across either',
          client.post('/api/admin/class-sessions/apply-time-suggestions',
                      json={'ids': [theirs.get_json()['id']]},
                      headers=auth).get_json()['skipped'],
          [{'id': theirs.get_json()['id'], 'reason': 'unknown'}])

    # ── Cleanup ──────────────────────────────────────────────────────────
    for scope in (org, other):
        wipe(cur, scope)
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM organizations WHERE slug IN "
                "('t-classes', 't-classes-other', 't-classes-dark')")
    check('cleanup removes the test organizations', cur.rowcount, 3)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All class catalogue checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
