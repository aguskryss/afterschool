"""Password reset and invitation redemption, end to end.

The property: someone who has forgotten their password, or who has just been
invited, can set one. That is the whole of it, and it was broken for every user
on the platform — silently, which is why it went unnoticed.

Both halves of the flow are unauthenticated, so no organization is pinned, and
both read a tenant-scoped table directly:

    forgot-password   SELECT * FROM users                  -> hidden by RLS
    reset-password    SELECT * FROM password_reset_tokens  -> hidden by RLS

The first fails invisibly: the route answers "if that email exists, a reset
link has been sent" either way, so it looked identical to a typo'd address. The
second is worse, because it also kills every invitation — an admin or parent
gets a real email with a real link, and the link cannot find its own token.

These tests go through Flask's test client so what runs is the real route, the
real before_request chain, and the real RLS.

Needs AUTH_OWNER_ROLE pointed at a BYPASSRLS role, exactly as production does,
or the SECURITY DEFINER functions the fix relies on buy nothing:

    AUTH_OWNER_ROLE=kikar_auth_owner \
    ADMIN_DATABASE_URL=postgresql://kikar_owner:...@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:...@localhost:5432/kikar \
    python3 tests/test_password_reset.py
"""

import os
import sys
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2
import psycopg2.extras

from server import app as app_module
from server.app import app

OWNER_URL = os.environ.get('ADMIN_DATABASE_URL', os.environ.get('DATABASE_URL', ''))

failures: list[str] = []

# Nothing here may reach the network. The route's own send is fire-and-forget
# and its result is not part of the property under test.
sent: list = []
app_module.send_email = lambda to, subject, html: sent.append((to, subject, html)) or True


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected!r}, got {actual!r}")
    if not ok:
        failures.append(label)


@contextmanager
def superadmin(cur):
    cur.execute("SELECT set_config('app.organization_id','',false),"
                "       set_config('app.is_superadmin','on',false)")
    try:
        yield
    finally:
        cur.execute("SELECT set_config('app.organization_id','',false),"
                    "       set_config('app.is_superadmin','off',false)")


def pin(cur, org_id):
    cur.execute("SELECT set_config('app.organization_id',%s,false),"
                "       set_config('app.is_superadmin','off',false)",
                ('' if org_id is None else str(org_id),))


def main() -> int:
    if not OWNER_URL:
        print('ADMIN_DATABASE_URL (or DATABASE_URL) is required.')
        return 2
    if not os.environ.get('AUTH_OWNER_ROLE'):
        print('AUTH_OWNER_ROLE must name a BYPASSRLS role, as it does in production.')
        return 2

    conn = psycopg2.connect(OWNER_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = True
    cur = conn.cursor()

    # The definer functions are only worth anything if they really do run as a
    # role that RLS does not apply to. Assert it rather than assume it: without
    # this, every check below could pass for the wrong reason on a database
    # where the handover silently did not happen.
    cur.execute("""
        SELECT r.rolbypassrls FROM pg_proc p
          JOIN pg_roles r ON r.oid = p.proowner
         WHERE p.proname = 'auth_reset_lookup'
    """)
    row = cur.fetchone()
    check('auth_reset_lookup runs as a role RLS does not apply to',
          row and row['rolbypassrls'], True)

    with superadmin(cur):
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-reset','t-reset2')")
        cur.execute("INSERT INTO organizations (slug,name) VALUES "
                    "('t-reset','Reset JCC') RETURNING id")
        org = cur.fetchone()['id']
        cur.execute("INSERT INTO organizations (slug,name) VALUES "
                    "('t-reset2','Other JCC') RETURNING id")
        other = cur.fetchone()['id']

    pin(cur, org)
    cur.execute(
        "INSERT INTO users (email, password_hash, role, name, organization_id) "
        "VALUES ('reset-me@example.test','x','parent','Reset Me',%s) RETURNING id",
        (org,))
    user_id = cur.fetchone()['id']

    pin(cur, other)
    cur.execute(
        "INSERT INTO users (email, password_hash, role, name, organization_id) "
        "VALUES ('other-jcc@example.test','x','admin','Other Admin',%s) RETURNING id",
        (other,))

    client = app.test_client()

    def token_for(user):
        with superadmin(cur):
            cur.execute("SELECT token FROM password_reset_tokens t JOIN users u "
                        "ON u.id = t.user_id WHERE u.email = %s AND t.used = 0 "
                        "ORDER BY t.id DESC LIMIT 1", (user,))
            found = cur.fetchone()
        return found['token'] if found else None

    # ── Forgetting a password ────────────────────────────────────────────────
    sent.clear()
    r = client.post('/api/auth/forgot-password', json={'email': 'reset-me@example.test'})
    check('forgot-password answers 200', r.status_code, 200)
    check('and it actually issues a token', token_for('reset-me@example.test') is not None, True)
    check('and actually sends the email', len(sent), 1)

    # The token has to belong to the same organization as its user, or the
    # tenant boundary has a row in it that belongs to nobody.
    with superadmin(cur):
        cur.execute("SELECT organization_id FROM password_reset_tokens "
                    "WHERE user_id = %s ORDER BY id DESC LIMIT 1", (user_id,))
        issued = cur.fetchone()
        check("the token lands in its user's organization",
              issued['organization_id'] if issued else None, org)

    # ── Redeeming it ─────────────────────────────────────────────────────────
    # A sentinel rather than None when the step above issued nothing: this file
    # has to report the regression it is here to catch, not die on it and take
    # the rest of the run with it.
    token = token_for('reset-me@example.test') or 'NO-TOKEN-WAS-ISSUED'
    r = client.post('/api/auth/reset-password',
                    json={'token': token, 'new_password': 'A-str0ng-Passphrase!'})
    check('the link can be redeemed', r.status_code, 200)
    check('and it says whose portal to open', (r.get_json() or {}).get('role'), 'parent')

    # The point of all of it: the password actually works.
    r = client.post('/api/auth/login', json={'email': 'reset-me@example.test',
                                             'password': 'A-str0ng-Passphrase!'})
    check('the new password signs in', r.status_code, 200)
    check('with the right organization on the token',
          (r.get_json() or {}).get('organization', {}).get('id')
          or (r.get_json() or {}).get('org'), org)

    # ── One-time means one time ──────────────────────────────────────────────
    r = client.post('/api/auth/reset-password',
                    json={'token': token, 'new_password': 'An0ther-Passphrase!'})
    check('a spent link cannot be reused', r.status_code, 400)
    r = client.post('/api/auth/login', json={'email': 'reset-me@example.test',
                                             'password': 'An0ther-Passphrase!'})
    check('so the second password never took effect', r.status_code, 401)

    # ── An invitation is the same flow, and was equally dead ─────────────────
    pin(cur, org)
    cur.execute(
        "INSERT INTO users (email, password_hash, role, name, organization_id) "
        "VALUES ('invited@example.test','unusable','admin','Invited',%s) RETURNING id",
        (org,))
    invited_id = cur.fetchone()['id']
    cur.execute("INSERT INTO password_reset_tokens (user_id, token, expires_at, "
                "organization_id) VALUES (%s,'INVITE-TOKEN-FIXTURE',"
                "NOW() + INTERVAL '7 days', %s)", (invited_id, org))
    r = client.post('/api/auth/reset-password',
                    json={'token': 'INVITE-TOKEN-FIXTURE',
                          'new_password': 'Invited-Passphrase!1'})
    check('an invitation link can be redeemed', r.status_code, 200)
    r = client.post('/api/auth/login', json={'email': 'invited@example.test',
                                             'password': 'Invited-Passphrase!1'})
    check('and the invited admin can sign in', r.status_code, 200)

    # ── What must still be refused ───────────────────────────────────────────
    r = client.post('/api/auth/reset-password',
                    json={'token': 'not-a-real-token', 'new_password': 'Whatever-1234!'})
    check('an invented token is refused', r.status_code, 400)

    with superadmin(cur):
        cur.execute("INSERT INTO password_reset_tokens (user_id, token, expires_at, "
                    "organization_id) VALUES (%s,'EXPIRED-FIXTURE',"
                    "NOW() - INTERVAL '1 hour', %s)", (user_id, org))
    r = client.post('/api/auth/reset-password',
                    json={'token': 'EXPIRED-FIXTURE', 'new_password': 'Whatever-1234!'})
    check('an expired token is refused', r.status_code, 400)

    r = client.post('/api/auth/forgot-password', json={'email': 'nobody@example.test'})
    check('an unknown address still answers the same way', r.status_code, 200)
    check('and issues nothing', token_for('nobody@example.test'), None)

    # A reset must not become a way to read across the boundary: the definer
    # function returns one row keyed by a 32-byte secret and no password hash.
    # A token of its own, unredeemed: the ones above have all been spent, and
    # the function correctly returns nothing for those.
    with superadmin(cur):
        cur.execute("INSERT INTO password_reset_tokens (user_id, token, expires_at, "
                    "organization_id) VALUES (%s,'SHAPE-FIXTURE',"
                    "NOW() + INTERVAL '1 hour', %s)", (user_id, org))
        cur.execute("SELECT * FROM auth_reset_lookup('SHAPE-FIXTURE')")
        columns = set((cur.fetchone() or {}).keys())
    check('the lookup hands back no password hash', 'password_hash' in columns, False)
    check('only what is needed to pin the tenant and finish',
          sorted(columns), ['id', 'organization_id', 'role', 'user_id'])

    # ── The superadmin, who has no organization at all ───────────────────────
    with superadmin(cur):
        cur.execute("INSERT INTO users (email, password_hash, role, name, "
                    "organization_id) VALUES "
                    "('t-sa@example.test','x','superadmin','Platform',NULL) RETURNING id")
        sa_id = cur.fetchone()['id']
    sent.clear()
    r = client.post('/api/auth/forgot-password', json={'email': 't-sa@example.test'})
    check('a superadmin can ask for a reset too', r.status_code, 200)
    check('and one is issued, despite having no organization',
          token_for('t-sa@example.test') is not None, True)
    sa_token = token_for('t-sa@example.test') or 'NO-TOKEN-WAS-ISSUED'
    r = client.post('/api/auth/reset-password',
                    json={'token': sa_token, 'new_password': 'Platform-Passphrase!1'})
    check('and the superadmin can redeem it', r.status_code, 200)
    r = client.post('/api/auth/login', json={'email': 't-sa@example.test',
                                             'password': 'Platform-Passphrase!1'})
    check('and sign in', r.status_code, 200)

    with superadmin(cur):
        cur.execute("DELETE FROM users WHERE id = %s", (sa_id,))
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-reset','t-reset2')")
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All password reset checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
