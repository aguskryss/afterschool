"""Module enforcement tests — the runtime half.

`test_module_access.py` proves the *map* is complete: every `/api` route either
belongs to a module or is deliberately core. It reads app.py as text and needs
no database.

This proves the *hook acts on the map*. Different property, and the one that
actually protects revenue: holding a valid token for a JCC that did not buy a
module, the endpoint has to refuse. Until the hook existed the toggles only hid
screens, and anyone who called the endpoint directly got the data.

It runs through Flask's test client rather than curl, so no server has to be
running and tokens are minted in process — the same `create_access_token` the
login route uses, with the same claims. What is exercised is the real
`before_request` chain, not a stand-in.

Needs a database: the hook reads `organizations.modules`.

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/jclub \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/jclub \
    .venv/bin/python tests/test_module_enforcement.py
"""

import json
import os
import re
import sys
from contextlib import contextmanager

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2
import psycopg2.extras

from server import tenancy
from server.app import app
from flask_jwt_extended import create_access_token

APP_URL = os.environ.get('DATABASE_URL', '')
OWNER_URL = os.environ.get('ADMIN_DATABASE_URL', APP_URL)

# The message the hook returns. Asserted on so a 403 that came from somewhere
# else — a role check, a missing row — cannot be mistaken for the module gate
# doing its job.
REFUSAL = 'This feature is not enabled for your organization'

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected}, got {actual}")
    if not ok:
        failures.append(label)


@contextmanager
def superadmin(cur):
    """A narrow window for the setup that runs above every organization.

    Creating one is a superadmin act — org_self carries
    WITH CHECK (is_superadmin = 'on'), and FORCE ROW LEVEL SECURITY applies it
    to the table's owner too — and deleting one needs the window for the same
    reason, because USING only matches the pinned organization. Both statements
    below are the fixture, not the thing under test.

    The scope is deliberately tight, and left closed in a finally: this file
    asserts that endpoints refuse, and a connection left superadmin would
    quietly change what those endpoints are allowed to see. See the longer note
    in tests/test_tenant_isolation.py.
    """
    cur.execute(
        "SELECT set_config('app.organization_id', '', false),"
        "       set_config('app.is_superadmin', 'on', false)"
    )
    try:
        yield
    finally:
        cur.execute(
            "SELECT set_config('app.organization_id', '', false),"
            "       set_config('app.is_superadmin', 'off', false)"
        )


def token(org_id, role='admin'):
    """A token indistinguishable from one the login route would hand out."""
    with app.app_context():
        return create_access_token(
            identity='1', additional_claims={'role': role, 'org': org_id, 'name': 'T'}
        )


def auth(tok):
    return {'Authorization': f'Bearer {tok}'}


def probe_routes():
    """One representative GET route per module, taken from the app's own map.

    Derived rather than hardcoded so a module added later is covered without
    anyone remembering to extend this file — the same reason the static test
    walks the route table instead of listing routes by hand.
    """
    found: dict[str, str] = {}
    for rule in app.url_map.iter_rules():
        if 'GET' not in (rule.methods or ()):
            continue
        path = str(rule)
        if not path.startswith('/api'):
            continue
        key = tenancy.module_for_path(path)
        if key is None or key in found:
            continue
        # Fill path parameters with a value that parses; the request must reach
        # the hook, and the hook runs before any handler looks the id up.
        concrete = re.sub(r'<[^:>]*:?([^>]*)>', '1', path)
        found[key] = concrete
    return found


def main() -> int:
    if not APP_URL:
        print('DATABASE_URL is required.')
        return 2

    owner = psycopg2.connect(OWNER_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    owner.autocommit = True
    oc = owner.cursor()

    # Two organizations that differ only in what they bought.
    #  - `bought`  has every module explicitly on
    #  - `nothing` has every module explicitly off
    # Explicit on both sides, so a check can never pass merely because a module
    # happens to default the way the test wanted.
    all_on = {k: True for k in tenancy.MODULES}
    all_off = {k: False for k in tenancy.MODULES}

    orgs = {}
    with superadmin(oc):
        for slug, name, mods in (
            ('t-bought', 'Bought Everything JCC', all_on),
            ('t-nothing', 'Bought Nothing JCC', all_off),
        ):
            oc.execute(
                "INSERT INTO organizations (slug, name, modules) VALUES (%s, %s, %s) "
                "ON CONFLICT (slug) DO UPDATE SET modules = EXCLUDED.modules RETURNING id",
                (slug, name, json.dumps(mods)),
            )
            orgs[slug] = oc.fetchone()['id']

    bought, nothing = orgs['t-bought'], orgs['t-nothing']
    client = app.test_client()
    routes = probe_routes()

    # ── The property itself, over every module that has routes ───────────────
    print(f"\nProbing {len(routes)} modules that have routes.\n")

    refused, leaked = [], []
    for key, path in sorted(routes.items()):
        r = client.get(path, headers=auth(token(nothing)))
        body = r.get_json(silent=True) or {}
        if r.status_code == 403 and body.get('error') == REFUSAL:
            refused.append(key)
        else:
            leaked.append(f'{key} ({path} -> {r.status_code})')

    check('every module with routes refuses a JCC that did not buy it', leaked, [])
    check('...and that is all of them', len(refused), len(routes))

    # The other half: the gate must not refuse what *was* bought. A hook that
    # returned 403 unconditionally would pass every check above.
    still_gated = []
    for key, path in sorted(routes.items()):
        r = client.get(path, headers=auth(token(bought)))
        body = r.get_json(silent=True) or {}
        if r.status_code == 403 and body.get('error') == REFUSAL:
            still_gated.append(f'{key} ({path})')
    check('a JCC that bought a module is not refused it', still_gated, [])

    # ── The deliberate exceptions ────────────────────────────────────────────
    sample = routes.get('photos') or next(iter(routes.values()))

    r = client.get(sample, headers=auth(token(nothing, role='superadmin')))
    check(
        'a superadmin is never locked out by a module',
        r.status_code == 403 and (r.get_json(silent=True) or {}).get('error') == REFUSAL,
        False,
    )

    # No organization means not signed in. That has to read as 401 from
    # @jwt_required, not 403 — a 403 would tell an anonymous caller that the
    # route exists and blame the wrong thing.
    r = client.get(sample)
    check('an unauthenticated call is 401, not a misleading 403', r.status_code, 401)

    # Preflights carry no credentials. Refusing them breaks CORS instead of
    # protecting anything; the real request behind them is still checked.
    r = client.options(sample, headers={
        'Origin': 'http://localhost:5173',
        'Access-Control-Request-Method': 'GET',
    })
    check('a CORS preflight is not refused', r.status_code == 403, False)

    # ── Core routes stay reachable no matter what is switched off ────────────
    # `nothing` has every single module off. Anything still answering is core
    # by construction, which is the line the pricing depends on.
    for label, path in (
        ('the auth check', '/api/auth/check'),
        ('the health probe', '/api/health'),
    ):
        r = client.get(path, headers=auth(token(nothing)))
        check(f'{label} survives every module being off', r.status_code == 403, False)

    # ── Defaults, through the hook rather than the pure function ─────────────
    # An organization with no `modules` at all falls back to the catalogue
    # defaults. `photos` defaults off, so it must be refused; `messages`
    # defaults on, so it must not be.
    with superadmin(oc):
        oc.execute(
            "INSERT INTO organizations (slug, name, modules) VALUES "
            "('t-default', 'Defaults JCC', %s) "
            "ON CONFLICT (slug) DO UPDATE SET modules = EXCLUDED.modules RETURNING id",
            (json.dumps({}),),
        )
        default_org = oc.fetchone()['id']

    for key, expect_403 in (('photos', True), ('messages', False)):
        path = routes.get(key)
        if not path:
            continue
        r = client.get(path, headers=auth(token(default_org)))
        got = r.status_code == 403 and (r.get_json(silent=True) or {}).get('error') == REFUSAL
        check(f"with no modules set, '{key}' follows its catalogue default", got, expect_403)

    # Needs the window as much as the inserts did: with no organization pinned,
    # USING matches nothing and this deletes nothing. The ON CONFLICT DO UPDATE
    # in the setup was covering for that, so the three organizations survived
    # every run.
    with superadmin(oc):
        oc.execute(
            "DELETE FROM organizations WHERE slug IN ('t-bought', 't-nothing', 't-default')"
        )
        oc.execute("SELECT count(*) FROM organizations WHERE slug LIKE 't-%'")
        check('the test cleans up after itself', oc.fetchone()['count'], 0)
    owner.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All module enforcement checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
