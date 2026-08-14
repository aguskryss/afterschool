"""Tests for the care-room catalogue (`daily_ops`, §6.1 step 3 / R7).

Rooms are the first thing the director configures and the last thing anything
else can do without: care rules point at a room, staff are assigned to a room in
a time block, and `Ocean - CARE` on a counselor's phone is a room's name. So the
properties worth protecting are less about CRUD than about not losing things.

THE THREE THAT MATTER:

  1. Deleting a room in use is refused, not cascaded. care_assignment_rules
     .room_id is ON DELETE CASCADE, so a permitted DELETE would take the grade
     ranges with it — and those are what decide where a child waits. Archiving
     (active = false) is the way to retire a room that is in use.

  2. Reviving an archived room keeps what it had. The name match folds case, so
     typing "pool" must not silently rename "Pool" — that string is what a
     counselor reads — and must not drop its capacity hint either.

  3. Two JCCs both get a room called "Gym", and neither can see the other's.
     rooms.name is unique per organization (PER_ORG_UNIQUES), and every read
     goes through the org_isolation policy rather than a WHERE clause.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://owner@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_daily_ops_rooms.py
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

# Rooms live behind daily_ops. Without it every route below is a 403, which is
# itself one of the checks.
MODULES = json.dumps({'daily_ops': True})
MODULES_OFF = json.dumps({'daily_ops': False})


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
    for table in ('care_assignment_rules', 'rooms'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    org = make_org(cur, 't-rooms', 'Rooms JCC', MODULES)
    other = make_org(cur, 't-rooms-other', 'Other JCC', MODULES)
    dark = make_org(cur, 't-rooms-dark', 'No Daily Ops JCC', MODULES_OFF)
    wipe(cur, org)
    wipe(cur, other)

    auth = {'Authorization': f'Bearer {token(org)}'}
    other_auth = {'Authorization': f'Bearer {token(other)}'}

    def post(body, headers=auth):
        return client.post('/api/admin/rooms', json=body, headers=headers)

    # ── The module gate ───────────────────────────────────────────────────
    # A screen is a courtesy; the refusal has to happen on the server.
    dark_auth = {'Authorization': f'Bearer {token(dark)}'}
    check('rooms are refused when daily_ops is off',
          client.get('/api/admin/rooms', headers=dark_auth).status_code, 403)
    check('creating a room is refused too',
          post({'name': 'Ocean'}, dark_auth).status_code, 403)

    # ── Roles ─────────────────────────────────────────────────────────────
    for role in ('counselor', 'parent'):
        headers = {'Authorization': f'Bearer {token(org, role=role)}'}
        check(f'a {role} cannot read the room list',
              client.get('/api/admin/rooms', headers=headers).status_code, 403)
        check(f'a {role} cannot create a room',
              post({'name': 'Sneaky'}, headers).status_code, 403)

    # ── Creating ──────────────────────────────────────────────────────────
    check('an empty program has no rooms',
          client.get('/api/admin/rooms', headers=auth).get_json(), [])

    ocean = post({'name': 'Ocean Room', 'sort_order': 10}).get_json()
    gym = post({'name': 'Gym', 'capacity_hint': 45, 'sort_order': 20}).get_json()
    pool = post({'name': 'Pool'}).get_json()
    check('a created room comes back active', ocean['active'], True)
    check('a capacity hint round-trips', gym['capacity_hint'], 45)
    check('an omitted capacity hint stays absent', pool['capacity_hint'], None)

    check('a duplicate name is refused', post({'name': 'Ocean Room'}).status_code, 409)
    # rooms.name is unique on the exact string, so "ocean room" would be a legal
    # second row. Two rooms differing only in case is a typo, not a decision.
    check('a name differing only in case is refused too',
          post({'name': '  ocean room  '}).status_code, 409)
    check('a blank name is refused', post({'name': '   '}).status_code, 400)
    check('a missing name is refused', post({}).status_code, 400)
    check('a non-numeric capacity is refused',
          post({'name': 'Attic', 'capacity_hint': 'lots'}).status_code, 400)
    check('a zero capacity is refused',
          post({'name': 'Attic', 'capacity_hint': 0}).status_code, 400)

    rooms = client.get('/api/admin/rooms', headers=auth).get_json()
    check('sort order wins, then the name',
          [r['name'] for r in rooms], ['Ocean Room', 'Gym', 'Pool'])
    check('a room with nothing pointing at it says so',
          rooms[0]['care_rule_count'], 0)

    # ── Editing ───────────────────────────────────────────────────────────
    # A body that mentions one field must leave the others alone, or the
    # restore button below would wipe a capacity hint on its way past.
    moved = client.put(f'/api/admin/rooms/{gym["id"]}',
                       json={'sort_order': 5}, headers=auth).get_json()
    check('a partial edit keeps the name', moved['name'], 'Gym')
    check('a partial edit keeps the capacity hint', moved['capacity_hint'], 45)
    check('a partial edit applies what it did send', moved['sort_order'], 5)

    check('renaming onto a taken name is refused',
          client.put(f'/api/admin/rooms/{gym["id"]}',
                     json={'name': 'ocean room'}, headers=auth).status_code, 409)
    check('editing a room that does not exist is a 404',
          client.put('/api/admin/rooms/999999',
                     json={'name': 'Nowhere'}, headers=auth).status_code, 404)

    # ── Archiving, and coming back ────────────────────────────────────────
    client.put(f'/api/admin/rooms/{pool["id"]}',
               json={'active': False, 'capacity_hint': 25}, headers=auth)
    listed = [r['name'] for r in client.get('/api/admin/rooms', headers=auth).get_json()]
    check('an archived room drops off the list', 'Pool' in listed, False)
    with_archived = client.get('/api/admin/rooms?include_archived=1',
                               headers=auth).get_json()
    check('it is still there when asked for',
          [(r['name'], r['active']) for r in with_archived if r['name'] == 'Pool'],
          [('Pool', False)])

    # Property 2. Typing the name of an archived room means "bring it back",
    # because the unique makes a second row impossible and a 409 would be a
    # dead end with no way out of the screen.
    revived = post({'name': 'pool'})
    check('creating an archived name revives it', revived.status_code, 200)
    body = revived.get_json()
    check('reviving does not rename it', body['name'], 'Pool')
    check('reviving keeps the capacity it had', body['capacity_hint'], 25)
    check('reviving makes it active again', body['active'], True)

    # ── Property 1: a room in use is not deletable ────────────────────────
    # No care-rule endpoint exists yet (that is the next piece), so the row goes
    # in directly. What is under test is the guard, not how the rule got there.
    pin(cur, org)
    cur.execute("INSERT INTO care_assignment_rules "
                "(day_of_week, time_block, grade_min, grade_max, room_id) "
                "VALUES (NULL, '3-4', 0, 0, %s)", (ocean['id'],))

    counted = client.get('/api/admin/rooms', headers=auth).get_json()
    check('the list reports what a room is load-bearing for',
          [r['care_rule_count'] for r in counted if r['id'] == ocean['id']], [1])

    refused = client.delete(f'/api/admin/rooms/{ocean["id"]}', headers=auth)
    check('deleting a room a care rule points at is refused',
          refused.status_code, 409)
    check('the refusal says how many rules', refused.get_json()['care_rule_count'], 1)
    pin(cur, org)
    cur.execute("SELECT COUNT(*) AS n FROM care_assignment_rules")
    check('AND THE CARE RULE IS STILL THERE', cur.fetchone()['n'], 1)

    check('the room a rule points at survives too',
          client.get('/api/admin/rooms', headers=auth).status_code, 200)

    # A room nothing points at is a typo, and a typo should be removable.
    check('deleting an unused room works',
          client.delete(f'/api/admin/rooms/{pool["id"]}', headers=auth).status_code, 200)
    check('and it is gone',
          [r['name'] for r in client.get('/api/admin/rooms?include_archived=1',
                                         headers=auth).get_json()],
          ['Gym', 'Ocean Room'])
    check('deleting it twice is a 404',
          client.delete(f'/api/admin/rooms/{pool["id"]}', headers=auth).status_code, 404)

    # ── Property 3: two JCCs, one room name, no leakage ───────────────────
    their_gym = post({'name': 'Gym'}, other_auth)
    check('another JCC may also have a room called Gym', their_gym.status_code, 201)
    check('and does not see ours',
          [r['name'] for r in client.get('/api/admin/rooms',
                                         headers=other_auth).get_json()],
          ['Gym'])
    check('nor do we see theirs',
          sorted(r['id'] for r in client.get('/api/admin/rooms',
                                             headers=auth).get_json()),
          sorted([ocean['id'], gym['id']]))

    # RLS makes the other organization's row invisible, so the handler's own
    # existence check misses and answers 404 — which is also the right answer to
    # give: 403 would confirm that the id is real.
    check('editing another JCC\'s room is a 404',
          client.put(f'/api/admin/rooms/{their_gym.get_json()["id"]}',
                     json={'name': 'Stolen'}, headers=auth).status_code, 404)
    check('deleting another JCC\'s room is a 404',
          client.delete(f'/api/admin/rooms/{their_gym.get_json()["id"]}',
                        headers=auth).status_code, 404)
    pin(cur, other)
    cur.execute("SELECT name FROM rooms")
    check('THEIR ROOM IS UNTOUCHED', [r['name'] for r in cur.fetchall()], ['Gym'])

    # ── Cleanup ───────────────────────────────────────────────────────────
    for scope in (org, other):
        wipe(cur, scope)
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM organizations WHERE slug IN "
                "('t-rooms', 't-rooms-other', 't-rooms-dark')")
    check('cleanup removes the test organizations', cur.rowcount, 3)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All room catalogue checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
