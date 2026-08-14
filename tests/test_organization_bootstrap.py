"""Opening a brand new organization, end to end.

The journey a superadmin makes when a JCC signs up: create the organization,
give it an administrator, hand that person a link, and have them arrive in
their own admin portal seeing their own JCC and nobody else's.

Every step of it was impossible until recently, for three separate reasons,
and each one is asserted here so it cannot quietly come back:

  • creating an organization created no way into it, and `require_admin()` is
    an exact match on 'admin', so a superadmin cannot use the admin screens to
    make one from the inside
  • the setup link the invitation produces could not be redeemed, because
    reset-password could not see its own token under RLS
  • and the new admin must land pinned to their own organization, not to the
    one the superadmin happened to be looking at

Runs the real routes through Flask's test client.

    AUTH_OWNER_ROLE=kikar_auth_owner \
    ADMIN_DATABASE_URL=postgresql://kikar_owner:...@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:...@localhost:5432/kikar \
    python3 tests/test_organization_bootstrap.py
"""

import os
import sys
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2
import psycopg2.extras

from server import app as app_module
from server.app import app
from flask_jwt_extended import create_access_token

OWNER_URL = os.environ.get('ADMIN_DATABASE_URL', os.environ.get('DATABASE_URL', ''))

failures: list[str] = []
app_module.send_email = lambda *a, **k: True


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected!r}, got {actual!r}")
    if not ok:
        failures.append(label)


@contextmanager
def superadmin_pin(cur):
    cur.execute("SELECT set_config('app.organization_id','',false),"
                "       set_config('app.is_superadmin','on',false)")
    try:
        yield
    finally:
        cur.execute("SELECT set_config('app.organization_id','',false),"
                    "       set_config('app.is_superadmin','off',false)")


def token(role, org=None):
    with app.app_context():
        return create_access_token(
            identity='1', additional_claims={'role': role, 'org': org, 'name': 'T'}
        )


def auth(tok):
    return {'Authorization': f'Bearer {tok}'}


def main() -> int:
    if not OWNER_URL or not os.environ.get('AUTH_OWNER_ROLE'):
        print('ADMIN_DATABASE_URL and AUTH_OWNER_ROLE are required.')
        return 2

    conn = psycopg2.connect(OWNER_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = True
    cur = conn.cursor()
    with superadmin_pin(cur):
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-newjcc','t-neighbour')")
        cur.execute("DELETE FROM users WHERE email IN "
                    "('t-newadmin@example.test','t-taken@example.test')")

    client = app.test_client()
    sa = auth(token('superadmin'))

    # ── The organization ─────────────────────────────────────────────────────
    r = client.post('/api/superadmin/organizations', json={
        'name': 'New JCC', 'slug': 't-newjcc'}, headers=sa)
    check('a superadmin can create an organization', r.status_code, 201)
    org = (r.get_json() or {})['id']

    r = client.post('/api/superadmin/organizations', json={
        'name': 'Neighbour JCC', 'slug': 't-neighbour'}, headers=sa)
    neighbour = (r.get_json() or {})['id']

    # It starts with nobody in it, which is the whole problem this solves.
    r = client.get(f'/api/superadmin/organizations/{org}/admins', headers=sa)
    check('a new organization starts with no administrator', r.get_json(), [])

    # ── The administrator ────────────────────────────────────────────────────
    r = client.post(f'/api/superadmin/organizations/{org}/admins', json={
        'name': 'New Admin', 'email': 'T-NewAdmin@Example.test'}, headers=sa)
    check('the superadmin can give it one', r.status_code, 201)
    created = r.get_json() or {}
    check('the address is stored lowercased', created.get('email'),
          't-newadmin@example.test')
    check('and a setup link comes back', bool(created.get('setup_url')), True)
    # The console shows this to a human and nothing else is ever sent, so a
    # password appearing in it would be a password sitting in someone's clipboard.
    check('no password is handed back',
          [k for k in created if 'password' in k.lower()], [])

    r = client.get(f'/api/superadmin/organizations/{org}/admins', headers=sa)
    listed = r.get_json() or []
    check('and the console lists them', [a['email'] for a in listed],
          ['t-newadmin@example.test'])
    check('shown as invited rather than active', listed[0]['password_set_at'], None)

    # ── Refusals ─────────────────────────────────────────────────────────────
    r = client.post(f'/api/superadmin/organizations/{org}/admins', json={
        'name': 'Dup', 'email': 't-newadmin@example.test'}, headers=sa)
    check('the same address cannot be added twice', r.status_code, 409)

    r = client.post(f'/api/superadmin/organizations/{org}/admins', json={
        'name': 'Bad', 'email': 'not-an-email'}, headers=sa)
    check('a malformed address is refused', r.status_code, 400)

    r = client.post('/api/superadmin/organizations/999999/admins', json={
        'name': 'Ghost', 'email': 't-ghost@example.test'}, headers=sa)
    check('an organization that does not exist is refused', r.status_code, 404)

    # The route reaches across organizations by definition, so the role check
    # on it is the only thing standing between a JCC admin and every other JCC.
    r = client.post(f'/api/superadmin/organizations/{neighbour}/admins', json={
        'name': 'Sneak', 'email': 't-sneak@example.test'},
        headers=auth(token('admin', org=org)))
    check("a JCC admin cannot add an admin to another JCC", r.status_code, 403)

    # ── Redeeming the link and arriving ──────────────────────────────────────
    token_value = created['setup_url'].split('token=')[-1]
    r = client.post('/api/auth/reset-password', json={
        'token': token_value, 'new_password': 'Brand-New-Passphrase!1'})
    check('the setup link can be redeemed', r.status_code, 200)

    r = client.post('/api/auth/login', json={
        'email': 't-newadmin@example.test', 'password': 'Brand-New-Passphrase!1'})
    check('and the new administrator can sign in', r.status_code, 200)
    body = r.get_json() or {}
    check('as an admin', body.get('role'), 'admin')

    r = client.get(f'/api/superadmin/organizations/{org}/admins', headers=sa)
    check('the console now shows them as active',
          (r.get_json() or [])[0]['password_set_at'] is not None, True)

    # The point of the whole exercise: they land in their own JCC.
    admin_token = auth(body['token'])
    r = client.get('/api/admin/schools', headers=admin_token)
    check('they reach their own admin portal', r.status_code, 200)

    # And their token carries their organization, not the superadmin's.
    with superadmin_pin(cur):
        cur.execute("SELECT organization_id FROM users WHERE email = %s",
                    ('t-newadmin@example.test',))
        check('bound to the organization they were created in',
              cur.fetchone()['organization_id'], org)

    with superadmin_pin(cur):
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-newjcc','t-neighbour')")
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All organization bootstrap checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
