"""Handing an admin a parent's or a fellow admin's password-setup link.

Counselors have had this since the mail provider turned out to be optional
(tests/test_counselor_setup_link.py). Parents and admins did not, so with mail
off the only accounts a JCC could actually onboard were its counselors.

The properties, and why each one is here:

  * THE LINK WORKS. A token that looks right but cannot be redeemed is worse
    than no button, because it fails at the person you gave it to.
  * IT IS NOT GATED BY PARENT_INVITES_ENABLED. That flag stops email going to
    parents. This route sends none — it hands a link to the administrator at
    the screen. Gating it would disable the workaround in exactly the situation
    it exists for, so there is a check that pins the two apart: with the flag
    off, resend-invite must refuse and setup-link must still work.
  * IT DOES NOT TOUCH password_hash. resend-invite rotates the hash before
    sending; with mail broken that silently locks out someone who already had a
    working password. Asking for a link must never be able to do that.
  * IT DOES NOT STAMP invited_at. No invitation was sent, and claiming one was
    puts "Invitation sent" on screen beside an empty inbox.
  * Only one link is live at a time, and it stays inside the organization.

Creating a parent is covered too: it now returns the setup link in the response
rather than printing it into the application log, where a live credential for a
named parent would sit in every deploy's output.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_setup_links.py
"""

import os
import sys
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server import app as app_module  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

NEW_PASSWORD = 'SetupLinkPw1!'


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
    cur.execute("DELETE FROM users WHERE organization_id = %s", (org_id,))
    return org_id


def add_user(cur, email, name, role):
    cur.execute("INSERT INTO users (email, password_hash, role, name) "
                "VALUES (%s, 'unusable', %s, %s) RETURNING id",
                (email, role, name))
    return cur.fetchone()['id']


def auth(org_id, role='admin'):
    with app.app_context():
        tok = create_access_token(
            identity='1', additional_claims={'role': role, 'org': org_id})
    return {'Authorization': f'Bearer {tok}'}


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

    org = make_org(cur, 't-setup', 'Setup JCC')
    other = make_org(cur, 't-setup-other', 'Other Setup JCC')
    pin(cur, other)
    stranger_parent = add_user(cur, 't-setup-stranger@example.com', 'Stranger', 'parent')
    pin(cur, org)

    def field(user_id, column):
        pin(cur, org)
        cur.execute(f"SELECT {column} FROM users WHERE id = %s", (user_id,))
        row = cur.fetchone()
        return row[column] if row else None

    # ── Both new routes, same invariants ──────────────────────────────────
    for role, endpoint, label in (
        ('parent', 'parents', 'Parent'),
        ('admin', 'admins', 'Admin'),
    ):
        print(f"\n── {label} setup link ──")
        pin(cur, org)
        uid = add_user(cur, f't-setup-{role}@example.com', f'A {label}', role)

        r = client.post(f'/api/admin/{endpoint}/{uid}/setup-link', headers=auth(org))
        check(f'{role}: a setup link is created', r.status_code, 200)
        body = r.get_json()
        check(f'{role}: it says how long it lasts', body['expires_in_days'], 7)
        check(f'{role}: it points at the reset page',
              urlparse(body['setup_url']).path, '/reset-password')
        first = token_of(body['setup_url'])
        check(f'{role}: and carries a token', bool(first), True)

        check(f'{role}: THE EXISTING PASSWORD HASH IS UNTOUCHED',
              field(uid, 'password_hash'), 'unusable')
        check(f'{role}: it does not claim an invitation was sent',
              field(uid, 'invited_at'), None)

        second = token_of(
            client.post(f'/api/admin/{endpoint}/{uid}/setup-link',
                        headers=auth(org)).get_json()['setup_url'])
        check(f'{role}: a second request mints a different token',
              first != second, True)
        check(f'{role}: and the first one stops working',
              client.post('/api/auth/reset-password',
                          json={'token': first,
                                'new_password': NEW_PASSWORD}).status_code, 400)

        r3 = client.post('/api/auth/reset-password',
                         json={'token': second, 'new_password': NEW_PASSWORD})
        check(f'{role}: the current link sets the password', r3.status_code, 200)
        check(f'{role}: and reports the role so the page can route',
              r3.get_json()['role'], role)
        check(f'{role}: a used link cannot be replayed',
              client.post('/api/auth/reset-password',
                          json={'token': second,
                                'new_password': NEW_PASSWORD}).status_code, 400)

        login = client.post('/api/auth/login',
                            json={'email': f't-setup-{role}@example.com',
                                  'password': NEW_PASSWORD})
        check(f'{role}: THEY CAN LOG IN WITH IT', login.status_code, 200)
        check(f'{role}: as a {role}', login.get_json()['role'], role)
        check(f'{role}: bound to their organization',
              login.get_json()['organization']['id'], org)

        # ── Who may ask ───────────────────────────────────────────────────
        check(f'{role}: an id that does not exist is a 404',
              client.post(f'/api/admin/{endpoint}/999999/setup-link',
                          headers=auth(org)).status_code, 404)
        for caller in ('counselor', 'parent'):
            check(f'{role}: a {caller} cannot mint one',
                  client.post(f'/api/admin/{endpoint}/{uid}/setup-link',
                              headers=auth(org, caller)).status_code, 403)
        check(f'{role}: an unauthenticated request is rejected',
              client.post(f'/api/admin/{endpoint}/{uid}/setup-link').status_code, 401)

    # ── The role in the URL has to match the role of the user ─────────────
    print("\n── Roles are not interchangeable ──")
    pin(cur, org)
    a_counselor = add_user(cur, 't-setup-c@example.com', 'A Counselor', 'counselor')
    check('a counselor id is not a parent',
          client.post(f'/api/admin/parents/{a_counselor}/setup-link',
                      headers=auth(org)).status_code, 404)
    check('a counselor id is not an admin',
          client.post(f'/api/admin/admins/{a_counselor}/setup-link',
                      headers=auth(org)).status_code, 404)

    # ── Tenancy ───────────────────────────────────────────────────────────
    print("\n── Tenancy ──")
    check("ANOTHER JCC'S PARENT IS A 404, NOT A LINK",
          client.post(f'/api/admin/parents/{stranger_parent}/setup-link',
                      headers=auth(org)).status_code, 404)

    # ── The flag stops email, not links ───────────────────────────────────
    #
    # The whole reason this route exists. With PARENT_INVITES_ENABLED off, the
    # email path must refuse and the link path must not: that is the situation
    # a JCC is in before its mail provider is configured, and it is when
    # onboarding has to keep working.
    print("\n── PARENT_INVITES_ENABLED gates email, not links ──")
    pin(cur, org)
    gated = add_user(cur, 't-setup-gated@example.com', 'Gated Parent', 'parent')
    original = app_module.PARENT_INVITES_ENABLED
    try:
        app_module.PARENT_INVITES_ENABLED = False
        check('with invites off, emailing one is refused',
              client.post(f'/api/admin/parents/{gated}/resend-invite',
                          headers=auth(org)).status_code, 403)
        check('WITH INVITES OFF, THE LINK STILL WORKS',
              client.post(f'/api/admin/parents/{gated}/setup-link',
                          headers=auth(org)).status_code, 200)
    finally:
        app_module.PARENT_INVITES_ENABLED = original

    # ── Creating a parent hands back the link ─────────────────────────────
    print("\n── Creating a parent returns the link ──")
    created = client.post('/api/admin/parents', headers=auth(org),
                          json={'name': 'Fresh Parent',
                                'email': 't-setup-fresh@example.com'})
    check('the parent is created', created.status_code, 200)
    payload = created.get_json()
    check('and the response carries a setup link',
          bool(payload.get('setup_url')), True)
    check('with an expiry the UI can show', payload.get('expires_in_days'), 7)
    fresh_token = token_of(payload['setup_url'])
    redeem = client.post('/api/auth/reset-password',
                         json={'token': fresh_token, 'new_password': NEW_PASSWORD})
    check('THE LINK FROM CREATION ACTUALLY WORKS', redeem.status_code, 200)
    check('and logs them in as a parent',
          client.post('/api/auth/login',
                      json={'email': 't-setup-fresh@example.com',
                            'password': NEW_PASSWORD}).get_json()['role'], 'parent')

    # Cleanup
    for oid in (org, other):
        pin(cur, oid)
        cur.execute("DELETE FROM password_reset_tokens WHERE user_id IN "
                    "(SELECT id FROM users WHERE organization_id = %s)", (oid,))
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM users WHERE organization_id = ANY(%s)", ([org, other],))
    cur.execute("DELETE FROM organizations WHERE id = ANY(%s)", ([org, other],))
    check('cleanup removes the test organizations', cur.rowcount, 2)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All setup link checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
