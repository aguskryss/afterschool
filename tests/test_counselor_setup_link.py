"""Tests for handing an admin a counselor's password-setup link.

An invitation email already carries exactly this link. With no mail provider
configured it is minted, thrown away, and reported as sent — so a JCC cannot
onboard a single member of staff and nothing on screen says why. This route
hands the link back instead, the same way the superadmin console does when it
creates a JCC's first admin.

The properties that matter:

  * The link actually works. A token that looks right but cannot be redeemed
    is worse than no button, because it fails at the person you gave it to.
  * It does NOT touch password_hash. resend-invite rotates the hash before
    sending; with mail broken that silently locks out a counselor who already
    had a working password. Asking for a link must never be able to do that.
  * Only one link is live at a time.
  * It stays inside the organization.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_counselor_setup_link.py
"""

import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

NEW_PASSWORD = 'CounselorPw1!'


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


def make_org(cur, slug, name):
    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, timezone) "
        "VALUES (%s, %s, 'America/New_York') "
        "ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id",
        (slug, name))
    org_id = cur.fetchone()['id']
    pin(cur, org_id)
    cur.execute("DELETE FROM password_reset_tokens WHERE user_id IN "
                "(SELECT id FROM users WHERE organization_id = %s)", (org_id,))
    cur.execute("DELETE FROM users WHERE organization_id = %s AND role <> 'admin'",
                (org_id,))
    return org_id


def add_user(cur, email, name, role):
    cur.execute("INSERT INTO users (email, password_hash, role, name) "
                "VALUES (%s, 'unusable', %s, %s) RETURNING id",
                (email, role, name))
    return cur.fetchone()['id']


def token(org_id, role='admin'):
    with app.app_context():
        return create_access_token(
            identity='1', additional_claims={'role': role, 'org': org_id})


def auth(org_id, role='admin'):
    return {'Authorization': f'Bearer {token(org_id, role)}'}


def token_of(url):
    return parse_qs(urlparse(url).query).get('token', [None])[0]


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)

    org = make_org(cur, 't-link', 'Link JCC')
    other = make_org(cur, 't-link-other', 'Other JCC')
    pin(cur, other)
    stranger = add_user(cur, 't-link-stranger@example.com', 'Stranger', 'counselor')
    pin(cur, org)
    counselor = add_user(cur, 't-link-c@example.com', 'A Counselor', 'counselor')
    parent = add_user(cur, 't-link-p@example.com', 'A Parent', 'parent')

    def hash_of(user_id):
        pin(cur, org)
        cur.execute("SELECT password_hash FROM users WHERE id = %s", (user_id,))
        return cur.fetchone()['password_hash']

    # ── The link is minted and looks like the emailed one ─────────────────
    r = client.post(f'/api/admin/counselors/{counselor}/setup-link',
                    headers=auth(org))
    check('a setup link is created', r.status_code, 200)
    body = r.get_json()
    check('it says how long it lasts', body['expires_in_days'], 7)
    check('it points at the reset page',
          urlparse(body['setup_url']).path, '/reset-password')
    first_token = token_of(body['setup_url'])
    check('and carries a token', bool(first_token), True)

    # ── It does not touch the password ────────────────────────────────────
    check('THE EXISTING PASSWORD HASH IS UNTOUCHED',
          hash_of(counselor), 'unusable')

    # ── Only one link is live at a time ───────────────────────────────────
    r2 = client.post(f'/api/admin/counselors/{counselor}/setup-link',
                     headers=auth(org))
    second_token = token_of(r2.get_json()['setup_url'])
    check('a second request mints a different token',
          first_token != second_token, True)
    check('and the first one stops working',
          client.post('/api/auth/reset-password',
                      json={'token': first_token,
                            'new_password': NEW_PASSWORD}).status_code, 400)

    # ── The link actually works ───────────────────────────────────────────
    r3 = client.post('/api/auth/reset-password',
                     json={'token': second_token, 'new_password': NEW_PASSWORD})
    check('the current link sets the password', r3.status_code, 200)
    check('and reports the role so the page can route',
          r3.get_json()['role'], 'counselor')
    check('the hash changed once it was used',
          hash_of(counselor) != 'unusable', True)
    check('a used link cannot be replayed',
          client.post('/api/auth/reset-password',
                      json={'token': second_token,
                            'new_password': NEW_PASSWORD}).status_code, 400)

    # ── And the counselor can now sign in ─────────────────────────────────
    login = client.post('/api/auth/login',
                        json={'email': 't-link-c@example.com',
                              'password': NEW_PASSWORD})
    check('THE COUNSELOR CAN LOG IN WITH IT', login.status_code, 200)
    check('as a counselor', login.get_json()['role'], 'counselor')
    check('bound to their organization',
          login.get_json()['organization']['id'], org)

    # ── Who may ask ───────────────────────────────────────────────────────
    check('a parent id is not a counselor',
          client.post(f'/api/admin/counselors/{parent}/setup-link',
                      headers=auth(org)).status_code, 404)
    check('an id that does not exist is a 404',
          client.post('/api/admin/counselors/999999/setup-link',
                      headers=auth(org)).status_code, 404)
    for role in ('counselor', 'parent'):
        check(f'a {role} cannot mint one',
              client.post(f'/api/admin/counselors/{counselor}/setup-link',
                          headers=auth(org, role)).status_code, 403)
    check('an unauthenticated request is rejected',
          client.post(f'/api/admin/counselors/{counselor}/setup-link').status_code,
          401)

    # ── Tenancy ───────────────────────────────────────────────────────────
    check("ANOTHER JCC'S COUNSELOR IS A 404, NOT A LINK",
          client.post(f'/api/admin/counselors/{stranger}/setup-link',
                      headers=auth(org)).status_code, 404)

    # Cleanup
    for oid in (org, other):
        pin(cur, oid)
        cur.execute("DELETE FROM password_reset_tokens WHERE user_id IN "
                    "(SELECT id FROM users WHERE organization_id = %s)", (oid,))
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM users WHERE organization_id = ANY(%s)",
                ([org, other],))
    cur.execute("DELETE FROM organizations WHERE id = ANY(%s)", ([org, other],))
    check('cleanup removes the test organizations', cur.rowcount, 2)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All counselor setup link checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
