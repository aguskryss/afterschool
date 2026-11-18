"""Tests for voiding a pickup release recorded by mistake.

A counselor taps the wrong child in the carpool line. Before this, nothing
could take that back: the child read as gone on every screen while still in
the building, and the correct release of the same child was refused by
UNIQUE (child_id, release_date).

The properties here:

  * Only an admin can void, and only with a reason.
  * Voiding moves the release — signature included — into
    pickup_release_voids. Nothing is lost.
  * The child's day goes back to present, so the correct release can be
    recorded right after with the normal flow.
  * The family is not pushed about the void; they hear about the real release.
  * Another organization cannot void, or even see, the release.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_pickup_void.py
"""

import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server import app as app_module  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

ORG_TZ = 'America/New_York'
TODAY = datetime.now(ZoneInfo(ORG_TZ)).strftime('%Y-%m-%d')
MODULES = '{"check_in_out": true, "secure_pickup": true}'
SIGNATURE = ('data:image/png;base64,'
             'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
             'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==')


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


def token(org_id, role, user_id='1', name=None):
    claims = {'role': role, 'org': org_id}
    if name:
        claims['name'] = name
    with app.app_context():
        return create_access_token(identity=str(user_id),
                                   additional_claims=claims)


def make_org(cur, slug):
    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, timezone, modules) "
        "VALUES (%s, %s, %s, %s::jsonb) "
        "ON CONFLICT (slug) DO UPDATE SET timezone = EXCLUDED.timezone, "
        "  modules = EXCLUDED.modules RETURNING id",
        (slug, slug, ORG_TZ, MODULES))
    org = cur.fetchone()['id']
    pin(cur, org)
    for table in ('pickup_release_voids', 'pickup_releases',
                  'authorized_pickup_people', 'attendance_records',
                  'counselor_schools', 'registrations', 'children', 'schools'):
        cur.execute(f"DELETE FROM {table} WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM users WHERE organization_id = %s", (org,))
    return org


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    # Record every push instead of sending it.
    pushes: list[tuple] = []
    app_module.notify_parent = lambda uid, kind, *a, **k: pushes.append((uid, kind))

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    other = make_org(cur, 't-void-other')
    cur.execute("INSERT INTO users (email, password_hash, role, name) "
                "VALUES ('t-void-oa@example.com', 'x', 'admin', 'Other Admin') "
                "RETURNING id")
    other_admin = cur.fetchone()['id']

    org = make_org(cur, 't-void')
    cur.execute("INSERT INTO schools (name) VALUES ('Brown') RETURNING id")
    brown = cur.fetchone()['id']

    def add_user(email, name, role):
        cur.execute("INSERT INTO users (email, password_hash, role, name) "
                    "VALUES (%s, 'x', %s, %s) RETURNING id", (email, role, name))
        return cur.fetchone()['id']

    admin = add_user('t-void-a@example.com', 'The Director', 'admin')
    counselor = add_user('t-void-c@example.com', 'A Counselor', 'counselor')
    parent = add_user('t-void-p@example.com', 'A Parent', 'parent')

    cur.execute("INSERT INTO children (name, parent_id, school_id) "
                "VALUES ('Wrong Child', %s, %s) RETURNING id", (parent, brown))
    child = cur.fetchone()['id']
    cur.execute("INSERT INTO counselor_schools (counselor_id, school_id) "
                "VALUES (%s, %s)", (counselor, brown))

    cauth = {'Authorization': f'Bearer {token(org, "counselor", counselor)}'}
    aauth = {'Authorization': f'Bearer {token(org, "admin", admin, "The Director")}'}
    oauth = {'Authorization': f'Bearer {token(other, "admin", other_admin)}'}

    def row():
        pin(cur, org)
        cur.execute("SELECT on_bus, status, checked_in_at, checked_out_at "
                    "  FROM attendance_records "
                    " WHERE child_id = %s AND attendance_date = %s",
                    (child, TODAY))
        return cur.fetchone()

    def release():
        return client.post('/api/counselor/pickup/release', headers=cauth,
                           json={'child_id': child, 'person_id': None,
                                 'signature': SIGNATURE})

    # ── The mistake ───────────────────────────────────────────────────────
    client.post('/api/counselor/attendance', headers=cauth,
                json={'date': TODAY,
                      'records': [{'child_id': child, 'on_bus': True}]})
    arrived = row()['checked_in_at']
    check('the mistaken release is recorded', release().status_code, 201)
    check('and the child reads as gone', row()['status'], 'checked_out')
    check('and a second release is refused', release().status_code, 409)

    releases = client.get(f'/api/admin/pickup-releases?start={TODAY}&end={TODAY}',
                          headers=aauth).get_json()
    release_id = releases['releases'][0]['id']

    # ── Who may void ──────────────────────────────────────────────────────
    check('a counselor cannot void',
          client.post(f'/api/admin/pickup-releases/{release_id}/void',
                      headers=cauth, json={'reason': 'oops'}).status_code, 403)
    check('another organization cannot void it',
          client.post(f'/api/admin/pickup-releases/{release_id}/void',
                      headers=oauth, json={'reason': 'oops'}).status_code, 404)
    check('a void without a reason is refused',
          client.post(f'/api/admin/pickup-releases/{release_id}/void',
                      headers=aauth, json={'reason': '   '}).status_code, 400)

    # ── The void ──────────────────────────────────────────────────────────
    pushes.clear()
    r = client.post(f'/api/admin/pickup-releases/{release_id}/void',
                    headers=aauth,
                    json={'reason': 'Wrong child selected'})
    check('an admin can void with a reason', r.status_code, 200)
    check('and the void names who did it', r.get_json()['voided_by_name'],
          'The Director')
    check('NO PUSH GOES TO THE FAMILY ON A VOID', pushes, [])

    after = row()
    check('the child is back in the building', after['status'], 'picked_up')
    check('with no checkout time', after['checked_out_at'], None)
    check('and their arrival time is untouched', after['checked_in_at'], arrived)

    pin(cur, org)
    cur.execute("SELECT count(*) AS n FROM pickup_releases WHERE child_id = %s",
                (child,))
    check('the release no longer stands', cur.fetchone()['n'], 0)
    cur.execute("SELECT person_name, void_reason, signature IS NOT NULL AS signed "
                "  FROM pickup_release_voids WHERE child_id = %s", (child,))
    kept = cur.fetchone()
    check('THE VOIDED RELEASE IS KEPT, SIGNATURE INCLUDED',
          (kept['person_name'], kept['void_reason'], kept['signed']),
          ('A Parent', 'Wrong child selected', True))

    check('voiding it again is a 404',
          client.post(f'/api/admin/pickup-releases/{release_id}/void',
                      headers=aauth, json={'reason': 'again'}).status_code, 404)

    log = client.get(f'/api/admin/pickup-releases?start={TODAY}&end={TODAY}',
                     headers=aauth).get_json()
    check('the log lists it as voided, not as a release',
          (len(log['releases']), len(log['voided'])), (0, 1))
    void_id = log['voided'][0]['id']
    sig = client.get(f'/api/admin/pickup-releases/voided/{void_id}/signature',
                     headers=aauth).get_json()
    check('the voided signature can still be read',
          sig['signature'].startswith('data:image/png;base64,'), True)
    check('another organization cannot read it',
          client.get(f'/api/admin/pickup-releases/voided/{void_id}/signature',
                     headers=oauth).status_code, 404)
    check('nor sees it in their log',
          client.get(f'/api/admin/pickup-releases?start={TODAY}&end={TODAY}',
                     headers=oauth).get_json()['voided'], [])

    # ── The correct release ───────────────────────────────────────────────
    pushes.clear()
    check('the correct release can now be recorded', release().status_code, 201)
    check('and the family hears about that one',
          [kind for _, kind in pushes], ['pickup_released'])
    check('and the child reads as gone again', row()['status'], 'checked_out')

    conn.close()
    print()
    if failures:
        print(f'{len(failures)} FAILED: {failures}')
        return 1
    print('All passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
