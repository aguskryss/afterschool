"""Closing a JCC down, and what is left when it is gone.

Deleting an organization is the most destructive thing the platform can do, and
the only operation with no undo anywhere behind it. What is asserted here is
therefore in two halves: that everything really goes, and that the few things
which must not go are still there afterwards.

  • the refusals come first — a wrong name, another JCC's name, an empty
    confirmation, a plain admin's token — because every one of them is a
    deletion that did not happen by accident
  • the cascade reaches all forty tables, not just the ones anyone remembers
  • the audit row outlives its organization, which it can only do by sitting
    outside the tenant schema with no foreign key back
  • the photographs' storage paths survive in that row, because the objects
    themselves are not in Postgres and nothing else knows where they are
  • and the neighbouring JCC is untouched, which is the assertion that would
    catch a WHERE clause going missing

Runs the real routes through Flask's test client.

    AUTH_OWNER_ROLE=kikar_auth_owner \
    ADMIN_DATABASE_URL=postgresql://kikar_owner:...@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:...@localhost:5432/kikar \
    python3 tests/test_organization_delete.py
"""

import json
import os
import sys
from contextlib import contextmanager

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import psycopg2
import psycopg2.extras

from server import tenancy
from server.app import app
from flask_jwt_extended import create_access_token

OWNER_URL = os.environ.get('ADMIN_DATABASE_URL', os.environ.get('DATABASE_URL', ''))

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected!r}, got {actual!r}")
    if not ok:
        failures.append(label)


@contextmanager
def superadmin(cur):
    """See tests/test_tenant_isolation.py for why this is deliberately narrow."""
    cur.execute("SELECT set_config('app.organization_id','',false),"
                "       set_config('app.is_superadmin','on',false)")
    try:
        yield
    finally:
        cur.execute("SELECT set_config('app.organization_id','',false),"
                    "       set_config('app.is_superadmin','off',false)")


def auth(user_id, role='superadmin', org=None):
    with app.app_context():
        token = create_access_token(
            identity=str(user_id),
            additional_claims={'role': role, 'org': org, 'name': 'T'},
        )
    return {'Authorization': f'Bearer {token}'}


# Every table that carries organization_id. Read from the database rather than
# listed here: a table added later is covered without anyone remembering this
# file, which is the whole point of asserting on the cascade.
def tenant_tables(cur) -> list:
    cur.execute("""
        SELECT s.relname
          FROM pg_constraint c
          JOIN pg_class s ON s.oid = c.conrelid
          JOIN pg_class t ON t.oid = c.confrelid
         WHERE c.contype = 'f' AND t.relname = 'organizations'
         ORDER BY 1
    """)
    return [r['relname'] for r in cur.fetchall()]


def rows_left(cur, tables, org) -> dict:
    out = {}
    for table in tables:
        cur.execute(f"SELECT count(*) AS n FROM {table} WHERE organization_id = %s", (org,))
        n = cur.fetchone()['n']
        if n:
            out[table] = n
    return out


def main() -> int:
    if not OWNER_URL:
        print('ADMIN_DATABASE_URL (or DATABASE_URL) is required.')
        return 2

    conn = psycopg2.connect(OWNER_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = True
    cur = conn.cursor()

    with superadmin(cur):
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-doomed','t-bystander')")
        cur.execute("DELETE FROM organization_deletions WHERE slug = 't-doomed'")
        cur.execute("DELETE FROM users WHERE email IN ('t-super@example.test','t-demoted@example.test')")

        mods = json.dumps({k: True for k in tenancy.MODULES})
        cur.execute("INSERT INTO organizations (slug,name,modules) VALUES "
                    "('t-doomed','Doomed JCC',%s) RETURNING id", (mods,))
        doomed = cur.fetchone()['id']
        cur.execute("INSERT INTO organizations (slug,name,modules) VALUES "
                    "('t-bystander','Bystander JCC',%s) RETURNING id", (mods,))
        bystander = cur.fetchone()['id']

        # A superadmin belongs to no organization — that is what makes them one.
        cur.execute("INSERT INTO users (email,name,role,password_hash,organization_id) "
                    "VALUES ('t-super@example.test','Super','superadmin','x',NULL) "
                    "RETURNING id")
        super_id = cur.fetchone()['id']

        # Populate both. The bystander gets the same shapes so that "the other
        # JCC still has its rows" is a real assertion and not a tautology.
        for org in (doomed, bystander):
            cur.execute("INSERT INTO schools (organization_id,name) VALUES (%s,'Brook') "
                        "RETURNING id", (org,))
            school = cur.fetchone()['id']
            cur.execute("INSERT INTO users (organization_id,email,name,role,password_hash) "
                        "VALUES (%s,%s,'A Parent','parent','x') RETURNING id",
                        (org, f'parent-{org}@example.test'))
            parent = cur.fetchone()['id']
            cur.execute("INSERT INTO children (organization_id,name,parent_id,school_id) "
                        "VALUES (%s,'Test Child',%s,%s) RETURNING id",
                        (org, parent, school))
            child = cur.fetchone()['id']
            cur.execute("INSERT INTO registrations (organization_id,child_id,day_of_week,"
                        "dismissal_time) VALUES (%s,%s,'Monday',5)", (org, child))
            cur.execute("INSERT INTO child_contacts (organization_id,child_id,priority,name) "
                        "VALUES (%s,%s,1,'A Contact')", (org, child))
            cur.execute("INSERT INTO photos (organization_id,storage_path,uploaded_by,"
                        "photo_date) VALUES (%s,%s,%s,'2026-08-03')",
                        (org, f'{org}/one.jpg', parent))

        tables = tenant_tables(cur)

    client = app.test_client()
    sa = auth(super_id)

    check('the whole tenant schema hangs off organizations', len(tables) >= 40, True)

    # ── What the confirmation screen is shown ────────────────────────────────
    r = client.get(f'/api/superadmin/organizations/{doomed}/inventory', headers=sa)
    check('the inventory can be read before deciding', r.status_code, 200)
    inventory = r.get_json() or {}
    check('and it counts what is actually there',
          (inventory.get('children'), inventory.get('parents'),
           inventory.get('schools'), inventory.get('photos')), (1, 1, 1, 1))

    # ── Refusals ─────────────────────────────────────────────────────────────
    r = client.delete(f'/api/superadmin/organizations/{doomed}', headers=sa, json={})
    check('a deletion with no confirmation is refused', r.status_code, 400)

    r = client.delete(f'/api/superadmin/organizations/{doomed}', headers=sa,
                      json={'confirm': 'doomed jcc'})
    check('the name has to match exactly, not loosely', r.status_code, 400)

    # The mistake this guard exists for: the right name, the wrong id.
    r = client.delete(f'/api/superadmin/organizations/{bystander}', headers=sa,
                      json={'confirm': 'Doomed JCC'})
    check("another organization's name does not unlock this one", r.status_code, 400)

    r = client.delete(f'/api/superadmin/organizations/{doomed}',
                      headers=auth(super_id, role='admin', org=doomed),
                      json={'confirm': 'Doomed JCC'})
    check('a JCC admin cannot delete their own organization', r.status_code, 403)

    r = client.delete('/api/superadmin/organizations/999999', headers=sa,
                      json={'confirm': 'Anything'})
    check('an organization that does not exist is 404', r.status_code, 404)

    with superadmin(cur):
        check('and after five refusals it is all still there',
              rows_left(cur, tables, doomed).get('children'), 1)

    # A caller who belongs to the organization is asking to delete their own
    # account along with it. users_org_role_check makes this impossible for a
    # current superadmin — they have no organization by construction — so the
    # case that can actually happen is a token minted before a demotion: it
    # still claims superadmin, while the row behind it is an admin of the JCC
    # about to be deleted.
    with superadmin(cur):
        cur.execute("INSERT INTO users (organization_id,email,name,role,password_hash) "
                    "VALUES (%s,'t-demoted@example.test','Was Super','admin','x') "
                    "RETURNING id", (doomed,))
        demoted = cur.fetchone()['id']
    r = client.delete(f'/api/superadmin/organizations/{doomed}',
                      headers=auth(demoted), json={'confirm': 'Doomed JCC'})
    check('a stale token cannot delete the organization it belongs to',
          r.status_code, 409)

    # ── The deletion ─────────────────────────────────────────────────────────
    r = client.delete(f'/api/superadmin/organizations/{doomed}', headers=sa,
                      json={'confirm': 'Doomed JCC'})
    check('with the name typed, it goes', r.status_code, 200)
    body = r.get_json() or {}
    check('and reports what went', body.get('deleted', {}).get('children'), 1)
    check('including the photographs it could not delete from here',
          body.get('photo_objects_attempted'), 1)

    with superadmin(cur):
        check('every table that carries organization_id is empty',
              rows_left(cur, tables, doomed), {})
        cur.execute("SELECT count(*) AS n FROM organizations WHERE id = %s", (doomed,))
        check('and the organization itself is gone', cur.fetchone()['n'], 0)

        # The point of the audit table: it is the only thing that knows this
        # JCC existed, so it has to be outside everything the cascade reaches.
        cur.execute("SELECT * FROM organization_deletions WHERE slug = 't-doomed'")
        record = cur.fetchone()
        check('the record of the deletion survives it', record is not None, True)
        check('naming who did it', record['deleted_by_email'], 't-super@example.test')
        check('and what was in it', record['counts']['children'], 1)
        # Without these the objects are unreachable bytes: the rows that held
        # their paths went with the cascade.
        check('and where the photographs are, which nothing else now knows',
              record['photo_paths'], [f'{doomed}/one.jpg'])

        check('the JCC next door still has its children',
              rows_left(cur, tables, bystander).get('children'), 1)

    # ── Who may read the record ──────────────────────────────────────────────
    r = client.get('/api/superadmin/deletions', headers=sa)
    check('a superadmin can read the log', r.status_code, 200)
    check('and finds the deletion in it',
          [d['slug'] for d in (r.get_json() or []) if d['slug'] == 't-doomed'],
          ['t-doomed'])

    r = client.get('/api/superadmin/deletions',
                   headers=auth(super_id, role='admin', org=bystander))
    check('a JCC admin cannot', r.status_code, 403)

    with superadmin(cur):
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-doomed','t-bystander')")
        cur.execute("DELETE FROM organization_deletions WHERE slug = 't-doomed'")
        cur.execute("DELETE FROM users WHERE email IN ('t-super@example.test','t-demoted@example.test')")
        cur.execute("SELECT count(*) AS n FROM organizations WHERE slug LIKE 't-%'")
        check('the test cleans up after itself', cur.fetchone()['n'], 0)
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All organization deletion checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
