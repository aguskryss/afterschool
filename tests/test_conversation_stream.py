"""The live-messaging stream, and the checks a new SSE endpoint has to repeat.

EventSource cannot send an Authorization header, so the token arrives as a
query parameter and `_bind_tenant` / `_enforce_module_access` never see it.
Every stream therefore repeats the decode, the organization pin and the module
check by hand (CLAUDE.md §8) — and "by hand" is exactly the kind of thing that
gets left out of the next one. This file is the check that it was not.

WHAT IS NOT TESTED HERE, AND WHY
    Not the happy path. A successful stream is an infinite generator; Flask's
    test client consumes a response body to completion, so asking for one would
    hang the suite rather than pass it. What is testable is every way in that
    must be refused, which is the part with the security consequences.

    The message actually arriving is exercised end-to-end by hand, and the
    publish side is a single pickup_events.publish() call on a bus that
    tests/test_operations_board.py already covers.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_conversation_stream.py
"""

import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

STREAM = '/api/admin/conversations/stream'


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


def token_for(role, org_id):
    with app.app_context():
        return create_access_token(
            identity='1', additional_claims={'role': role, 'org': org_id})


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
        "INSERT INTO organizations (slug, name, timezone, modules) "
        "VALUES ('t-stream', 'Stream JCC', 'America/New_York', %s::jsonb) "
        "ON CONFLICT (slug) DO UPDATE SET modules = EXCLUDED.modules RETURNING id",
        (json.dumps({'parent_messaging': True}),))
    org = cur.fetchone()['id']

    cur.execute(
        "INSERT INTO organizations (slug, name, timezone, modules) "
        "VALUES ('t-stream-off', 'No Messaging JCC', 'America/New_York', %s::jsonb) "
        "ON CONFLICT (slug) DO UPDATE SET modules = EXCLUDED.modules RETURNING id",
        (json.dumps({'parent_messaging': False}),))
    org_off = cur.fetchone()['id']

    # ── The token has to be there, and has to be a token ──────────────────
    print("\nThe token is in the query string, so it is checked by hand")

    check('no token is 401', client.get(STREAM).status_code, 401)
    check('a junk token is 401',
          client.get(f'{STREAM}?token=not-a-jwt').status_code, 401)
    check('an empty token is 401',
          client.get(f'{STREAM}?token=').status_code, 401)

    # ── Role ──────────────────────────────────────────────────────────────
    print("\nOnly an admin reads the office inbox")

    for role in ('parent', 'counselor'):
        check(f'a {role} is refused',
              client.get(f'{STREAM}?token={token_for(role, org)}').status_code, 403)
    # A superadmin belongs to no organization, so there is no inbox to stream.
    check('a superadmin is refused too',
          client.get(f'{STREAM}?token={token_for("superadmin", None)}').status_code,
          403)

    # ── Organization ──────────────────────────────────────────────────────
    print("\nA token with no organization cannot open a per-organization feed")

    check('an admin token carrying no org is refused',
          client.get(f'{STREAM}?token={token_for("admin", None)}').status_code, 403)

    # ── The module check that _enforce_module_access could not do ─────────
    #
    # This is the one the docs warn about. The hook saw no token, so it let the
    # request through; if the handler does not repeat the check, an
    # organization that never bought parent messaging gets a live feed of it.
    print("\nThe module is enforced inside the handler, not by the hook")

    check('AN ORGANIZATION WITHOUT parent_messaging IS REFUSED',
          client.get(f'{STREAM}?token={token_for("admin", org_off)}').status_code,
          403)

    # ── The parent feed is a different door with a different rule ─────────
    print("\nThe parent feed refuses staff, and vice versa")

    check('an admin cannot open the parent feed',
          client.get(f'/api/parent/stream?token={token_for("admin", org)}').status_code,
          403)
    check('no token on the parent feed is 401',
          client.get('/api/parent/stream').status_code, 401)

    # ── The event type is actually wired on both sides ────────────────────
    #
    # Static, but it is the join that makes the feature work: the publisher and
    # the two forwarders have to agree on one string, and a typo in any of them
    # is a message that is sent and never arrives.
    print("\nPublisher and forwarders agree on the event name")

    src = open(os.path.join(os.path.dirname(os.path.dirname(
        os.path.abspath(__file__))), 'server', 'app.py'), encoding='utf-8').read()
    # Matched as a publish call, not as a substring: the admin feed's filter
    # tuple ('conversation-message', 'resync') contains the same text, and
    # counting bare occurrences reads two publishers as three.
    check('both send routes publish it',
          len(re.findall(r"pickup_events\.publish\(\s*'conversation-message'", src)),
          2)
    check('the parent feed forwards it',
          "'conversation-message')" in src or
          "'conversation-message'," in src, True)
    check('a NOTIFY too large to fit still reaches the parent feed',
          "event.get('type') == 'resync'" in src, True)
    check('and the admin feed forwards resync too',
          "('conversation-message', 'resync')" in src, True)

    # Cleanup
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM organizations WHERE id = ANY(%s)", ([org, org_off],))
    check('cleanup removes the test organizations', cur.rowcount, 2)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All conversation stream checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
