"""Tests for dated counselor school assignments.

The workflow these exist for is the one the program hits every week: someone
calls out, and another counselor covers their school for one afternoon without
either of them losing their standing assignment.

THE PROPERTY THAT MATTERS MOST is the three-state rule in
counselor_school_ids(), because getting it wrong is a silent privilege change
rather than a visible bug:

    no assignment rows at all      -> every school   (fail-open, by design)
    rows, some in effect today     -> those schools
    rows, none in effect today     -> NO schools     (must NOT read as "all")

The third state did not exist before assignments had dates. Collapsing it into
the first would hand a counselor whose one-day cover expired the entire
organization at midnight, with nothing on any screen to say so.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_counselor_assignments.py
"""

import os
import sys
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app, counselor_school_ids, counselor_covers_child  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

# The organization below runs on Eastern time, and so must these dates.
# Building them from date.today() reads the container's clock, which is UTC in
# CI and on Render — so for the four hours after 8pm Eastern the test's
# "yesterday" is the app's "today" and an expired window is still open. That
# is the very bug phase 2 fixed in the application; the test has to hold
# itself to the same rule or it asserts against a day the app is not having.
ORG_TZ = 'America/New_York'
TODAY = datetime.now(ZoneInfo(ORG_TZ)).date()
YESTERDAY = (TODAY - timedelta(days=1)).isoformat()
TOMORROW = (TODAY + timedelta(days=1)).isoformat()
NEXT_WEEK = (TODAY + timedelta(days=7)).isoformat()
LAST_WEEK = (TODAY - timedelta(days=7)).isoformat()


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
        "INSERT INTO organizations (slug, name, timezone) "
        "VALUES ('t-assign', 'Assignment JCC', %s) "
        "ON CONFLICT (slug) DO UPDATE SET timezone = EXCLUDED.timezone RETURNING id",
        (ORG_TZ,))
    org = cur.fetchone()['id']
    pin(cur, org)
    for table in ('counselor_school_changes', 'counselor_schools',
                  'registrations', 'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org,))

    schools = {}
    for name in ('Brown', 'Glover', 'SPS'):
        cur.execute("INSERT INTO schools (name) VALUES (%s) RETURNING id", (name,))
        schools[name] = cur.fetchone()['id']

    def add_user(email, name, role):
        cur.execute("INSERT INTO users (email, password_hash, role, name) "
                    "VALUES (%s, 'x', %s, %s) RETURNING id", (email, role, name))
        return cur.fetchone()['id']

    admin_id = add_user('t-assign-admin@example.com', 'The Admin', 'admin')
    angelie = add_user('t-assign-angelie@example.com', 'Angelie Fischer', 'counselor')
    fischer = add_user('t-assign-fischer@example.com', 'Gianna Khloe', 'counselor')
    nobody = add_user('t-assign-nobody@example.com', 'Unassigned Person', 'counselor')

    parent = add_user('t-assign-parent@example.com', 'A Parent', 'parent')
    cur.execute("INSERT INTO children (name, parent_id, school_id) "
                "VALUES ('Brown Child', %s, %s) RETURNING id",
                (parent, schools['Brown']))
    brown_child = cur.fetchone()['id']

    auth = {'Authorization': f'Bearer {token(org, "admin", str(admin_id))}'}

    # ── Assigning ─────────────────────────────────────────────────────────
    r = client.post(f'/api/admin/counselors/{angelie}/schools/{schools["Brown"]}',
                    json={}, headers=auth)
    check('a permanent assignment is created', r.status_code, 201)

    r = client.get(f'/api/admin/counselors/{angelie}/schools', headers=auth)
    body = r.get_json()
    check('it comes back as permanent', body['schools'][0]['permanent'], True)
    check('and in effect today', body['schools'][0]['in_effect'], True)
    check('having rows means she no longer covers every school',
          body['covers_all_schools'], False)

    # The whole workflow: cover Brown tomorrow without touching Angelie's.
    r = client.post(f'/api/admin/counselors/{fischer}/schools/{schools["Brown"]}',
                    json={'effective_from': TOMORROW, 'effective_to': TOMORROW},
                    headers=auth)
    check('a one-day cover is accepted', r.status_code, 201)

    r = client.get(f'/api/admin/counselors/{angelie}/schools', headers=auth)
    check("covering for someone does not touch their assignment",
          [s['school'] for s in r.get_json()['schools']], ['Brown'])

    r = client.get(f'/api/admin/counselors/{fischer}/schools', headers=auth)
    cover = r.get_json()['schools'][0]
    check('the cover is not permanent', cover['permanent'], False)
    check('and is not in effect today', cover['in_effect'], False)
    r = client.get(f'/api/admin/counselors/{fischer}/schools?date={TOMORROW}',
                   headers=auth)
    check('but is in effect tomorrow',
          r.get_json()['schools'][0]['in_effect'], True)

    # Assignments are additive: a second school does not replace the first.
    client.post(f'/api/admin/counselors/{angelie}/schools/{schools["Glover"]}',
                json={}, headers=auth)
    r = client.get(f'/api/admin/counselors/{angelie}/schools', headers=auth)
    check('adding a school keeps the existing one',
          sorted(s['school'] for s in r.get_json()['schools']),
          ['Brown', 'Glover'])

    # ── The three-state rule ──────────────────────────────────────────────
    database.set_script_organization(org)
    db = database.get_db()
    try:
        check('a counselor with no rows covers every school',
              counselor_school_ids(db, nobody, TODAY.isoformat()), None)
        check('a counselor with a live row covers just it',
              sorted(counselor_school_ids(db, angelie, TODAY.isoformat())),
              sorted([schools['Brown'], schools['Glover']]))
        check("a cover that has not started yet covers nothing today",
              counselor_school_ids(db, fischer, TODAY.isoformat()), [])
        check('and covers its school on the day it applies',
              counselor_school_ids(db, fischer, TOMORROW), [schools['Brown']])

        # The trap. An expired assignment is rows-but-none-in-effect, and must
        # never be read as the no-rows case.
        cur.execute("UPDATE counselor_schools SET effective_from = %s, "
                    "  effective_to = %s "
                    " WHERE counselor_id = %s AND school_id = %s",
                    (LAST_WEEK, YESTERDAY, fischer, schools['Brown']))
        check('AN EXPIRED ASSIGNMENT COVERS NOTHING, NOT EVERYTHING',
              counselor_school_ids(db, fischer, TODAY.isoformat()), [])
        check('and it is still not everything on the child check',
              counselor_covers_child(db, fischer, brown_child, TODAY.isoformat()),
              False)
        check('while the unassigned counselor really does cover the child',
              counselor_covers_child(db, nobody, brown_child, TODAY.isoformat()),
              True)
        check('and the permanently assigned one does too',
              counselor_covers_child(db, angelie, brown_child, TODAY.isoformat()),
              True)
    finally:
        db.close()
        database.set_script_organization(None)

    # A counselor whose assignments have all expired must not see a roster.
    croster = client.get(
        '/api/counselor/roster',
        headers={'Authorization': f'Bearer {token(org, "counselor", str(fischer))}'})
    check('the expired counselor gets an empty roster, not every school',
          croster.get_json(), [])
    nroster = client.get(
        '/api/counselor/roster',
        headers={'Authorization': f'Bearer {token(org, "counselor", str(nobody))}'})
    check('the never-assigned counselor still gets every school',
          len(nroster.get_json()), 3)

    # ── Removing ──────────────────────────────────────────────────────────
    r = client.delete(
        f'/api/admin/counselors/{angelie}/schools/{schools["Glover"]}',
        headers=auth)
    check('removing one school succeeds', r.status_code, 200)
    r = client.get(f'/api/admin/counselors/{angelie}/schools', headers=auth)
    check('and leaves the other alone',
          [s['school'] for s in r.get_json()['schools']], ['Brown'])
    check('removing an assignment that is not there is a 404',
          client.delete(f'/api/admin/counselors/{angelie}/schools/{schools["SPS"]}',
                        headers=auth).status_code, 404)

    # ── The PUT no longer wipes windows ───────────────────────────────────
    client.post(f'/api/admin/counselors/{angelie}/schools/{schools["SPS"]}',
                json={'effective_from': TOMORROW, 'effective_to': NEXT_WEEK},
                headers=auth)
    client.put(f'/api/admin/counselors/{angelie}/schools',
               json={'school_ids': [schools['Brown'], schools['SPS']]},
               headers=auth)
    r = client.get(f'/api/admin/counselors/{angelie}/schools', headers=auth)
    sps = next(s for s in r.get_json()['schools'] if s['school'] == 'SPS')
    check('a bulk set leaves an untouched window intact',
          (sps['effective_from'], sps['effective_to']), (TOMORROW, NEXT_WEEK))

    # ── Validation ────────────────────────────────────────────────────────
    check('a backwards window is rejected',
          client.post(f'/api/admin/counselors/{angelie}/schools/{schools["Glover"]}',
                      json={'effective_from': NEXT_WEEK, 'effective_to': TOMORROW},
                      headers=auth).status_code, 400)
    check('a malformed date is rejected',
          client.post(f'/api/admin/counselors/{angelie}/schools/{schools["Glover"]}',
                      json={'effective_from': '3 August'},
                      headers=auth).status_code, 400)
    check('an unknown school is a 404',
          client.post(f'/api/admin/counselors/{angelie}/schools/999999',
                      json={}, headers=auth).status_code, 404)
    check('a counselor id that is really a parent is a 404',
          client.post(f'/api/admin/counselors/{parent}/schools/{schools["Brown"]}',
                      json={}, headers=auth).status_code, 404)

    # ── The log ───────────────────────────────────────────────────────────
    log = client.get('/api/admin/counselor-assignments/log', headers=auth).get_json()
    # Exactly the five writes made above, and nothing else — the bulk PUT that
    # set the same two schools already assigned must not manufacture history.
    check('every change is on the record, and only the real ones',
          sorted((e['action'], e['school_name']) for e in log),
          sorted([('added', 'Brown'), ('added', 'Brown'), ('added', 'Glover'),
                  ('removed', 'Glover'), ('added', 'SPS')]))
    check('the log is newest first',
          [e['id'] for e in log] == sorted((e['id'] for e in log), reverse=True),
          True)
    newest = log[0]
    check('the log names the admin who made the change',
          newest['changed_by_name'], 'The Admin')
    check('and the counselor it was about',
          {e['counselor_name'] for e in log} >= {'Angelie Fischer', 'Gianna Khloe'},
          True)
    check('a removal is on the record',
          any(e['action'] == 'removed' and e['school_name'] == 'Glover'
              for e in log), True)
    check('a temporary grant records its window',
          any(e['action'] == 'added' and e['school_name'] == 'Brown'
              and e['effective_to'] == TOMORROW for e in log), True)
    filtered = client.get(
        f'/api/admin/counselor-assignments/log?counselor_id={fischer}',
        headers=auth).get_json()
    check('the log filters by counselor',
          {e['counselor_name'] for e in filtered}, {'Gianna Khloe'})

    # A deleted school must not erase the history of having been assigned it.
    pin(cur, org)
    cur.execute("DELETE FROM counselor_schools WHERE school_id = %s",
                (schools['Glover'],))
    cur.execute("DELETE FROM schools WHERE id = %s", (schools['Glover'],))
    log = client.get('/api/admin/counselor-assignments/log', headers=auth).get_json()
    check('the log survives the school being deleted',
          any(e['school_name'] == 'Glover' for e in log), True)

    # ── Creation ──────────────────────────────────────────────────────────
    # Schools picked in the add-counselor form are assignments too, so the
    # history of a counselor's schools starts on their first day.
    r = client.post('/api/admin/counselors',
                    json={'name': 'Brand New', 'email': 't-assign-new@example.com',
                          'school_ids': [schools['Brown']]},
                    headers=auth)
    check('creating a counselor with a school succeeds', r.status_code in (200, 201), True)
    fresh = client.get('/api/admin/counselor-assignments/log',
                       headers=auth).get_json()
    check('and that assignment is on the record',
          any(e['counselor_name'] == 'Brand New' and e['action'] == 'added'
              and e['school_name'] == 'Brown' for e in fresh), True)

    # ── Roles ─────────────────────────────────────────────────────────────
    for role in ('counselor', 'parent'):
        rr = client.get(f'/api/admin/counselors/{angelie}/schools',
                        headers={'Authorization': f'Bearer {token(org, role)}'})
        check(f'a {role} cannot read assignments', rr.status_code, 403)
    check('a counselor cannot assign themselves a school',
          client.post(f'/api/admin/counselors/{fischer}/schools/{schools["Brown"]}',
                      json={},
                      headers={'Authorization': f'Bearer {token(org, "counselor")}'}
                      ).status_code, 403)

    # Cleanup
    pin(cur, org)
    for table in ('counselor_school_changes', 'counselor_schools',
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
    print('All counselor assignment checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
