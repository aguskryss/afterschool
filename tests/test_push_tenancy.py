"""Push notifications have to run with an organization pinned.

THE BUG THIS EXISTS FOR
    `push_subscriptions` is a tenant table with RLS. Every background push went
    through a bare threading.Thread, which has no flask.g and no thread pin, so
    database._resolve_organization() returned None, the connection was pinned to
    no organization, and the org_isolation policy matched nothing.

    Every async push read zero subscriptions and sent nothing. Messages from the
    office, attendance checks, pickup-claimed, day-off decisions — all of it.

    It hid for as long as it did because of how it failed. The log said
    "0 subscription(s) found", which reads as "that parent has not turned
    notifications on". Nothing errored, nothing retried, and the admin
    broadcast reported "attempted=N failed=0" having delivered to nobody.

WHAT IS CHECKED
    That the fix holds in the only place it can be checked cheaply: the thread
    entry points capture an organization and pin it, and the sender refuses to
    run without one rather than reporting an honest-looking zero.

    Not the delivery itself — that needs FCM/APNs and a real subscription, and
    a test that needs the network to pass is a test that fails for reasons that
    are not the code.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_push_tenancy.py
"""

import ast
import io
import os
import sys
import threading
import tokenize
from contextlib import redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import database  # noqa: E402
from server import app as app_module  # noqa: E402

failures: list[str] = []

APP_PY = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'server', 'app.py'
)


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected!r}, got {actual!r}")
    if not ok:
        failures.append(label)


def main() -> int:
    source = open(APP_PY, encoding='utf-8').read()
    tree = ast.parse(source)
    defs = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}

    # ── The thread entry points pin the organization ──────────────────────
    print("\nEvery thread that pushes carries its organization")

    for name in ('send_push_to_user_async', '_run_broadcast_pushes'):
        node = defs.get(name)
        body = ast.get_source_segment(source, node) if node else ''
        check(f'{name}() exists', node is not None, True)
        check(f'{name}() pins the thread',
              'set_thread_organization' in body, True)

    # The broadcast worker must be *given* the organization rather than looking
    # it up: by the time it runs, the request that knew it is gone.
    worker = defs.get('_run_broadcast_pushes')
    check('the broadcast worker takes organization_id as an argument',
          worker is not None and 'organization_id' in [a.arg for a in worker.args.args],
          True)

    # ...and the caller has to actually pass it.
    check('the caller passes it in',
          'current_org_id()' in source.split('target=_run_broadcast_pushes')[1][:400],
          True)

    # send_push_to_user_async has to resolve the organization OUTSIDE the
    # thread. Resolving inside is the bug wearing a different hat: flask.g is
    # already gone by then.
    async_node = defs.get('send_push_to_user_async')
    inner = next((n for n in ast.walk(async_node)
                  if isinstance(n, ast.FunctionDef) and n.name != 'send_push_to_user_async'),
                 None)
    check('it defines the thread body as a nested function', inner is not None, True)
    if inner is not None:
        outer_src = ast.get_source_segment(source, async_node) or ''
        inner_src = ast.get_source_segment(source, inner) or ''
        before = outer_src.split(inner_src)[0]
        check('AND RESOLVES THE ORGANIZATION BEFORE THE THREAD STARTS',
              '_ambient_org_id()' in before, True)
        check('the thread body only consumes it',
              '_ambient_org_id()' not in inner_src, True)

    # ── The sender refuses to run blind ───────────────────────────────────
    print("\nWith no organization in scope, the sender says so")

    sender = defs.get('send_push_to_user')
    sender_src = ast.get_source_segment(source, sender) if sender else ''
    check('send_push_to_user checks for an organization',
          '_ambient_org_id()' in sender_src, True)

    # The check has to come before the query, or it reports an honest-looking
    # zero and then explains itself.
    if sender_src:
        guard = sender_src.find('_ambient_org_id()')
        query = sender_src.find('FROM push_subscriptions')
        check('and does so BEFORE reading push_subscriptions',
              guard != -1 and query != -1 and guard < query, True)

    # ── It behaves that way at runtime, not just in the source ────────────
    print("\nAnd it behaves that way when actually called")

    # A bare thread is exactly the context the bug lived in: no request, no pin.
    result = {}

    def unpinned():
        buf = io.StringIO()
        with redirect_stdout(buf):
            app_module.send_push_to_user(1, 'title', 'body')
        result['log'] = buf.getvalue()

    t = threading.Thread(target=unpinned)
    t.start()
    t.join(timeout=30)

    log = result.get('log', '')
    if 'PUSH SKIP' in log:
        # No VAPID key configured in this environment, so the earlier guard
        # fires first and the tenant check is unreachable. Say so rather than
        # reporting a pass that proved nothing.
        print('SKIP  runtime check: push is not configured here '
              '(no VAPID key), so the tenant guard is unreachable')
    else:
        check('an unpinned call is reported as a bug, not as zero subscriptions',
              'PUSH BUG' in log, True)
        check('and it does not claim it found subscriptions',
              'subscription(s) found' in log, False)

    # ── The tenant table really is behind RLS ─────────────────────────────
    #
    # The whole failure depends on this being true. If push_subscriptions ever
    # stopped being tenant-scoped the guard above would be pointless ceremony —
    # and, far worse, one JCC's pushes could reach another's devices.
    print("\npush_subscriptions is tenant-scoped, which is why any of this matters")

    from server import tenancy  # noqa: E402
    check('it is registered in TENANT_TABLES',
          'push_subscriptions' in tenancy.TENANT_TABLES, True)

    if database.DATABASE_URL:
        conn = database._connect_with_retry(database.ADMIN_DATABASE_URL)
        conn.autocommit = True
        cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)
        cur.execute("SELECT relrowsecurity, relforcerowsecurity FROM pg_class "
                    " WHERE relname = 'push_subscriptions'")
        row = cur.fetchone()
        check('RLS is enabled on it', bool(row and row['relrowsecurity']), True)
        check('and forced, so it applies to the table owner too',
              bool(row and row['relforcerowsecurity']), True)
        cur.close()
        conn.close()
    else:
        print('SKIP  RLS check: DATABASE_URL is not set')

    # ── No push call site was left resolving the org inside a thread ──────
    print("\nNo other push path spawns a thread without pinning")

    # Resolved through the target function, not by proximity. The pin lives
    # inside the worker, which is often defined hundreds of lines from where
    # the thread is started — a "is there a pin nearby" check reads correct
    # code as broken and would be deleted the first time it cried wolf.
    #
    # Threads whose target never touches a tenant table need no pin. Each entry
    # here is a claim that the function does no database work; adding one is a
    # statement about what that function does, not a way to silence this.
    NO_DB_TARGETS = {
        # Builds a message and hands it to Resend over HTTPS. Its organization
        # travels as an already-resolved EmailIdentity argument.
        'send_email',
    }

    def pins_org(fn_name, scope):
        node = next((n for n in ast.walk(scope)
                     if isinstance(n, ast.FunctionDef) and n.name == fn_name), None)
        if node is None:
            return None
        return any(
            isinstance(n, ast.Attribute) and n.attr == 'set_thread_organization'
            or isinstance(n, ast.Name) and n.id == 'set_thread_organization'
            for n in ast.walk(node)
        )

    unpinned = []
    for node in ast.walk(tree):
        if not (isinstance(node, ast.Call)
                and isinstance(node.func, ast.Attribute)
                and node.func.attr == 'Thread'):
            continue
        target = next((kw.value for kw in node.keywords if kw.arg == 'target'), None)
        name = target.id if isinstance(target, ast.Name) else None
        if name is None or name in NO_DB_TARGETS:
            continue
        if pins_org(name, tree) is not True:
            unpinned.append(f'{name}() at app.py:{node.lineno}')

    # Compared as lists so a failure names the offenders instead of printing
    # False, which would send the next person hunting for which thread it meant.
    check('every thread whose target touches the database pins its organization',
          unpinned, [])

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('Push notifications carry their organization.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
