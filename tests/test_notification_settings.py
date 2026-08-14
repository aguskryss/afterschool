"""What a JCC's parents get notified about, and the daily attendance check.

THE PROPERTY THAT MATTERS MOST
    A switch that only some events consult is worse than no switch at all: the
    admin unticks "child was picked up", the pushes keep arriving, and now the
    screen is lying. So every parent-facing push goes through one function —
    notify_parent() — and this file checks statically that none of them slipped
    past it.

WHY THE DEFAULTS FAIL OPEN
    The opposite of modules, deliberately. An unknown module is something
    unpaid for and must fail closed. An unknown notification key is an event
    this organization has never been asked about, and withholding it silently
    would look like a bug: the JCC sees the thing happen, no notification
    arrives, and nothing on screen explains why.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret KIKAR_NO_SCHEDULER=1 \
    python3 tests/test_notification_settings.py
"""

import ast
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# The ticker sends real pushes on a timer; a test importing app.py should not
# quietly acquire one.
os.environ.setdefault('KIKAR_NO_SCHEDULER', '1')

from server import database, scheduler, tenancy  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []

APP_PY = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'server', 'app.py'
)


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


def auth(org_id, role='admin'):
    with app.app_context():
        tok = create_access_token(
            identity='1', additional_claims={'role': role, 'org': org_id})
    return {'Authorization': f'Bearer {tok}'}


def main() -> int:
    source = open(APP_PY, encoding='utf-8').read()
    tree = ast.parse(source)

    # ── Every parent push goes through the one gate ───────────────────────
    print("\nNo parent-facing push bypasses the preference")

    # Calls to send_push_to_user_async whose recipient is a parent. Identified
    # by the argument rather than by eye: `parent_id`, or a row's parent_id.
    leaked = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
                and node.func.id == 'send_push_to_user_async'):
            continue
        recipient = ast.dump(node.args[0]) if node.args else ''
        if not recipient:
            recipient = ast.dump(next((k.value for k in node.keywords
                                       if k.arg == 'user_id'), ast.Constant(None)))
        if 'parent_id' in recipient:
            leaked.append(f'app.py:{node.lineno}')
    check('no push to a parent_id skips notify_parent()', leaked, [])

    # And the gate is the only thing that consults the catalogue, so there is
    # one place to get it wrong.
    gate = next((n for n in ast.walk(tree)
                 if isinstance(n, ast.FunctionDef) and n.name == 'notify_parent'), None)
    check('notify_parent() exists', gate is not None, True)
    gate_src = ast.get_source_segment(source, gate) if gate else ''
    check('and it is the thing that checks the preference',
          'notification_on' in gate_src, True)

    # ── The catalogue's own rules ─────────────────────────────────────────
    print("\nDefaults, and what an unknown key does")

    check('every catalogued event is on by default',
          sorted(k for k, v in tenancy.default_notifications().items() if not v), [])
    check('an unset key follows its catalogue default',
          tenancy.notification_on({}, 'pickup_claimed'), True)
    check('an explicit false wins',
          tenancy.notification_on({'pickup_claimed': False}, 'pickup_claimed'), False)
    check('AN UNKNOWN KEY FAILS OPEN, UNLIKE A MODULE',
          tenancy.notification_on({}, 'something_added_later'), True)
    check('…and modules still fail closed, which is the contrast',
          tenancy.module_enabled({}, 'something_added_later'), False)

    # ── Scheduling arithmetic, in the organization's own timezone ─────────
    print("\nThe schedule is due in the JCC's time, not the server's")

    from datetime import timedelta
    from zoneinfo import ZoneInfo

    tz = 'America/New_York'
    now = scheduler._now_local(tz)
    hhmm = now.strftime('%H:%M')
    check('a time equal to now is due', scheduler._is_due(hhmm, tz), True)
    check('a time an hour from now is not',
          scheduler._is_due((now + timedelta(hours=1)).strftime('%H:%M'), tz), False)
    # Late is still useful; much later is noise, because pickup has happened.
    check('ten minutes ago still counts as due',
          scheduler._is_due((now - timedelta(minutes=10)).strftime('%H:%M'), tz), True)
    check('two hours ago does not',
          scheduler._is_due((now - timedelta(hours=2)).strftime('%H:%M'), tz), False)
    check('no time set is never due', scheduler._is_due(None, tz), False)
    check('a malformed time is never due', scheduler._is_due('lunchtime', tz), False)
    # The whole reason the time is stored as text against a timezone column.
    other = 'Pacific/Honolulu'
    check('the same wall clock is not due in another timezone',
          scheduler._is_due(hhmm, other),
          scheduler._now_local(other).strftime('%H:%M') == hhmm)

    if not database.DATABASE_URL:
        print('\nDATABASE_URL is not set; skipping the endpoint checks.')
        return 1 if failures else 0

    app.config['TESTING'] = True
    client = app.test_client()

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)
    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, timezone) "
        "VALUES ('t-notif', 'Notify JCC', 'America/New_York') "
        "ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id")
    org = cur.fetchone()['id']

    # ── Who may change them ───────────────────────────────────────────────
    print("\nThe organization's own admin owns these, unlike modules")

    for role in ('parent', 'counselor'):
        check(f'a {role} cannot read them',
              client.get('/api/admin/notification-settings',
                         headers=auth(org, role)).status_code, 403)
        check(f'a {role} cannot write them',
              client.put('/api/admin/notification-settings', headers=auth(org, role),
                         json={'notifications': {}}).status_code, 403)
    check('an unauthenticated read is rejected',
          client.get('/api/admin/notification-settings').status_code, 401)

    # ── Read, write, read back ────────────────────────────────────────────
    print("\nSettings round-trip")

    r = client.get('/api/admin/notification-settings', headers=auth(org))
    check('an admin can read them', r.status_code, 200)
    body = r.get_json()
    check('the catalogue travels with the values',
          len(body['catalogue']), len(tenancy.PARENT_NOTIFICATIONS))
    check('an untouched organization has everything on',
          all(body['notifications'].values()), True)
    check('and no schedule', body['attendance_check_at'], None)

    r = client.put('/api/admin/notification-settings', headers=auth(org),
                   json={'notifications': {'pickup_released': False}})
    check('a switch can be turned off', r.status_code, 200)
    check('it comes back off', r.get_json()['notifications']['pickup_released'], False)
    check('and the others are untouched',
          r.get_json()['notifications']['pickup_claimed'], True)

    check('an unknown key is rejected, not ignored',
          client.put('/api/admin/notification-settings', headers=auth(org),
                     json={'notifications': {'not_a_real_event': True}}).status_code,
          400)

    # ── The time ──────────────────────────────────────────────────────────
    print("\nThe attendance-check time")

    check('a valid time is accepted',
          client.put('/api/admin/notification-settings', headers=auth(org),
                     json={'attendance_check_at': '13:30'}).get_json()
              ['attendance_check_at'], '13:30')
    for bad in ('25:00', '1:30', '13:70', 'noon', '13:30:00'):
        check(f'{bad!r} is refused',
              client.put('/api/admin/notification-settings', headers=auth(org),
                         json={'attendance_check_at': bad}).status_code, 400)
    check('empty turns it off',
          client.put('/api/admin/notification-settings', headers=auth(org),
                     json={'attendance_check_at': ''}).get_json()
              ['attendance_check_at'], None)

    # ── The claim: once per organization per day ──────────────────────────
    print("\nA daily job runs once, however many workers tick")

    from datetime import date
    today = date.today()
    cur.execute("DELETE FROM scheduled_runs WHERE organization_id = %s", (org,))
    check('the first worker wins the claim',
          scheduler._claim(org, 'attendance_check', today), True)
    check('THE SECOND DOES NOT', scheduler._claim(org, 'attendance_check', today), False)
    check('a third does not either',
          scheduler._claim(org, 'attendance_check', today), False)
    check('tomorrow is a separate claim',
          scheduler._claim(org, 'attendance_check', today + timedelta(days=1)), True)
    check('and a different job today is too',
          scheduler._claim(org, 'something_else', today), True)

    # ── The attendance check actually runs ────────────────────────────────
    #
    # It shipped raising AttributeError on its first line: today_for_org()
    # returns a 'YYYY-MM-DD' string and _weekday_name() wants a date. The admin
    # saw "Could not send the attendance check" and there was nothing on screen
    # to say which of a dozen things had gone wrong. Called for real here
    # rather than inspected, because the failure was a type error that no
    # amount of reading the source would have caught.
    print("\nThe attendance check runs rather than raising")

    from server.app import _run_attendance_check
    from server.database import set_thread_organization
    set_thread_organization(org)
    with app.app_context():
        try:
            asked = _run_attendance_check(org)
            check('it completes and reports a count', isinstance(asked, int), True)
        except Exception as e:
            check('it completes and reports a count',
                  f'{e.__class__.__name__}: {e}', 'no exception')

    # ── A childless parent is unreachable, and the screen says so ─────────
    #
    # Every audience is resolved through `children`, even "everyone". A parent
    # added by hand and not yet given a child can be messaged individually and
    # will never receive a broadcast — which reads as "broadcasts are broken".
    print("\nThe compose screen admits who it cannot reach")

    conn2 = owner_conn()
    cur2 = conn2.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)
    pin(cur2, org)
    cur2.execute("DELETE FROM users WHERE email = 't-notif-orphan@example.com'")
    cur2.execute("INSERT INTO users (email, password_hash, role, name) "
                 "VALUES ('t-notif-orphan@example.com', 'x', 'parent', 'Orphan') "
                 "RETURNING id")
    orphan = cur2.fetchone()['id']

    r = client.post('/api/admin/messages/preview-count', headers=auth(org),
                    json={'audience_type': 'all'})
    check('the preview answers', r.status_code, 200)
    body = r.get_json()
    check('it names the field the client reads', 'recipient_count' in body, True)
    check('A CHILDLESS PARENT IS COUNTED AS UNREACHABLE',
          body.get('parents_without_children', 0) >= 1, True)
    check('and is not counted as a recipient', body['recipient_count'], 0)

    pin(cur2, org)
    cur2.execute("DELETE FROM users WHERE id = %s", (orphan,))
    cur2.close()
    conn2.close()

    # ── The cron door ─────────────────────────────────────────────────────
    print("\nThe cron endpoint is closed unless a secret is configured")

    was = os.environ.pop('CRON_SECRET', None)
    check('with no secret set the route is closed, not open',
          client.post('/api/cron/run-due').status_code, 503)
    os.environ['CRON_SECRET'] = 'test-secret-value'
    try:
        check('a wrong secret is refused',
              client.post('/api/cron/run-due',
                          headers={'X-Cron-Secret': 'nope'}).status_code, 403)
        check('a missing header is refused',
              client.post('/api/cron/run-due').status_code, 403)
        r = client.post('/api/cron/run-due',
                        headers={'X-Cron-Secret': 'test-secret-value'})
        check('the right secret is let in', r.status_code, 200)
        check('and it reports what ran', isinstance(r.get_json()['ran'], list), True)
    finally:
        os.environ.pop('CRON_SECRET', None)
        if was is not None:
            os.environ['CRON_SECRET'] = was

    # Cleanup
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM scheduled_runs WHERE organization_id = %s", (org,))
    cur.execute("DELETE FROM organizations WHERE id = %s", (org,))
    check('cleanup removes the test organization', cur.rowcount, 1)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('Notification settings hold.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
