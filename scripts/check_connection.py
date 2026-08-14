#!/usr/bin/env python3
"""Check a Postgres connection string before putting it in Render.

Two things about this app's database connection fail silently if they're
wrong, which is exactly why they deserve a script instead of a checklist:

  * a role that bypasses row level security leaves tenant isolation inert —
    every policy is in place and none of them apply; and
  * a pooler in transaction mode doesn't support LISTEN/NOTIFY, so the live
    pickup queue never delivers anything and nothing logs an error.

Usage — the URL is read from the environment, never from the command line, so
it doesn't end up in your shell history:

    DATABASE_URL='postgresql://...' python3 scripts/check_connection.py

Run it once for DATABASE_URL (the kikar_app role) and once for
ADMIN_DATABASE_URL (the owner).
"""

import os
import select
import sys

import psycopg2
import psycopg2.extensions

URL = os.environ.get('DATABASE_URL') or os.environ.get('ADMIN_DATABASE_URL')

if not URL:
    print("Set DATABASE_URL (or ADMIN_DATABASE_URL) in the environment first.")
    sys.exit(2)


def redacted(url: str) -> str:
    """Show enough to identify the connection, never the password."""
    if '@' not in url:
        return url
    creds, host = url.rsplit('@', 1)
    user = creds.split('//', 1)[-1].split(':', 1)[0]
    return f"{user}:***@{host}"


print(f"Connecting to {redacted(URL)}\n")

problems: list[str] = []

try:
    conn = psycopg2.connect(URL, connect_timeout=15)
    conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
except Exception as e:
    print(f"FAIL  Could not connect: {e}")
    print("\nIf this times out from a hosting provider, the direct connection")
    print("may be IPv6-only. Use the session pooler string instead.")
    sys.exit(1)

cur = conn.cursor()

cur.execute("SELECT current_user, current_database(), version()")
user, database, version = cur.fetchone()
print(f"PASS  Connected as {user!r} to {database!r}")
print(f"      {version.split(',')[0]}\n")

# ── Does this role bypass RLS? ────────────────────────────────────────────
cur.execute("SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user")
row = cur.fetchone()
bypasses, is_super = (row if row else (None, None))

if bypasses:
    print(f"WARN  {user!r} bypasses row level security.")
    print("      Correct for ADMIN_DATABASE_URL, which only runs init_db().")
    print("      Wrong for DATABASE_URL: isolation policies would not apply.")
else:
    print(f"PASS  {user!r} is subject to row level security.")
print()

# ── Does this connection support LISTEN/NOTIFY? ───────────────────────────
try:
    cur.execute("LISTEN kikar_conn_probe")
    cur.execute("SELECT pg_notify('kikar_conn_probe', 'ok')")

    # Poll unconditionally rather than only when select() says the socket is
    # readable: a notification a connection sent to itself can already be
    # buffered by libpq, in which case the socket never becomes readable and
    # select() alone would report a false failure.
    heard = False
    deadline = 5.0
    while deadline > 0 and not heard:
        conn.poll()
        while conn.notifies:
            if conn.notifies.pop(0).payload == 'ok':
                heard = True
        if heard:
            break
        select.select([conn], [], [], 0.5)
        deadline -= 0.5

    if heard:
        print("PASS  LISTEN/NOTIFY works. Live pickup will deliver.")
    else:
        print("FAIL  NOTIFY was accepted but never arrived.")
        print("      This is the transaction-mode pooler. Live pickup would")
        print("      silently never reach anyone. Use the session pooler")
        print("      (port 5432) or the direct connection.")
        problems.append('listen')
    cur.execute("UNLISTEN kikar_conn_probe")
except Exception as e:
    print(f"FAIL  LISTEN/NOTIFY unsupported on this connection: {e}")
    print("      Use the session pooler (port 5432) or the direct connection.")
    problems.append('listen')

conn.close()

print()
if problems:
    print("Not usable as DATABASE_URL yet — see above.")
    sys.exit(1)
print("This connection string is good to use.")
