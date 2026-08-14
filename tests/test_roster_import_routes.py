"""The roster importer as the browser meets it.

`test_roster_staging.py` calls the staging functions directly and proves what
they do to the database. This proves the seven HTTP routes wrapped around them,
which is a different thing and the thing the review screen actually talks to:
the status codes it branches on, the JSON keys it reads, and the two gates that
have to hold before any of it runs.

What it protects, each of which would fail silently in the other direction:

  • the module gate — a JCC that did not buy `daily_ops` gets 403, not a parse
  • the role gate — a counselor holding a valid token gets 403
  • the file check — a CSV is refused with a reason, because this importer
    reads the sheet layout and a CSV does not carry one
  • a batch commits exactly once, and cannot be discarded afterwards
  • the shape the screen destructures: id, totals.actions, schools[], rows[]

The workbook fixture is imported from test_roster_staging rather than copied:
one synthetic roster, invented children, no second copy to drift.

    AUTH_OWNER_ROLE=kikar_auth_owner \
    ADMIN_DATABASE_URL=postgresql://kikar_owner:...@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:...@localhost:5432/kikar \
    python3 tests/test_roster_import_routes.py
"""

import io
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

from test_roster_staging import base_rows, workbook

OWNER_URL = os.environ.get('ADMIN_DATABASE_URL', os.environ.get('DATABASE_URL', ''))

# The module hook's own message. Asserted on so a 403 from the role check — or
# from a missing row — cannot be mistaken for the module gate doing its job.
MODULE_REFUSAL = 'This feature is not enabled for your organization'

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


def auth(user_id, org, role='admin'):
    with app.app_context():
        token = create_access_token(
            identity=str(user_id),
            additional_claims={'role': role, 'org': org, 'name': 'T'},
        )
    return {'Authorization': f'Bearer {token}'}


def upload(client, headers, filename='roster.xlsx', rows=None):
    """POST a workbook the way a browser's file input would."""
    buffer = workbook(base_rows() if rows is None else rows)
    return client.post(
        '/api/admin/roster-import',
        headers=headers,
        content_type='multipart/form-data',
        data={'file': (io.BytesIO(buffer.getvalue()), filename)},
    )


def main() -> int:
    if not OWNER_URL:
        print('ADMIN_DATABASE_URL (or DATABASE_URL) is required.')
        return 2

    conn = psycopg2.connect(OWNER_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = True
    cur = conn.cursor()

    # Two organizations differing only in what they bought, plus one admin and
    # one counselor in the buying one. Both module states are explicit: a check
    # must never pass because `daily_ops` happened to default the way this test
    # wanted it to.
    with superadmin(cur):
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-routes','t-nomodule')")
        cur.execute(
            "INSERT INTO organizations (slug, name, modules) "
            "VALUES ('t-routes','Routes JCC', %s) RETURNING id",
            (json.dumps({k: True for k in tenancy.MODULES}),),
        )
        org = cur.fetchone()['id']
        cur.execute(
            "INSERT INTO organizations (slug, name, modules) "
            "VALUES ('t-nomodule','No Module JCC', %s) RETURNING id",
            (json.dumps({k: k != 'daily_ops' for k in tenancy.MODULES}),),
        )
        bare = cur.fetchone()['id']

        cur.execute(
            "INSERT INTO users (organization_id, email, name, role, password_hash) "
            "VALUES (%s, 't-routes-admin@example.test', 'Routes Admin', 'admin', 'x') "
            "RETURNING id", (org,))
        admin_id = cur.fetchone()['id']
        cur.execute(
            "INSERT INTO users (organization_id, email, name, role, password_hash) "
            "VALUES (%s, 't-routes-counselor@example.test', 'C', 'counselor', 'x') "
            "RETURNING id", (org,))
        counselor_id = cur.fetchone()['id']

    client = app.test_client()
    admin = auth(admin_id, org)

    # ── The two gates, before anything is parsed ─────────────────────────────
    r = upload(client, auth(counselor_id, org, role='counselor'))
    check('a counselor cannot upload a roster', r.status_code, 403)

    r = client.get('/api/admin/roster-import', headers=auth(admin_id, bare))
    check('a JCC without the module is refused', r.status_code, 403)
    check('...by the module gate, not something else',
          (r.get_json() or {}).get('error'), MODULE_REFUSAL)

    r = client.get('/api/admin/roster-import')
    check('and an unauthenticated call is 401, not a misleading 403',
          r.status_code, 401)

    # ── What counts as a roster file ─────────────────────────────────────────
    r = client.post('/api/admin/roster-import', headers=admin,
                    content_type='multipart/form-data', data={})
    check('a request with no file is refused', r.status_code, 400)

    r = upload(client, admin, filename='roster.csv')
    check('a CSV is refused', r.status_code, 400)
    check('...with a reason a person can act on',
          'CSV' in ((r.get_json() or {}).get('error') or ''), True)

    # ── Staging ──────────────────────────────────────────────────────────────
    r = upload(client, admin)
    check('a workbook stages', r.status_code, 201)
    staged = r.get_json() or {}
    batch = staged.get('id')

    # The exact shape the review screen destructures. A rename here is a blank
    # screen there, and nothing else in the suite would notice.
    check('the preview carries the keys the screen reads',
          sorted(k for k in ('id', 'filename', 'status', 'totals', 'schools', 'rows')
                 if k in staged),
          ['filename', 'id', 'rows', 'schools', 'status', 'totals'])
    check('it comes back as a preview, not a done deal', staged.get('status'), 'preview')
    check('the actions are counted', staged['totals']['actions']['create'], 3)
    check('and the unreadable rows are counted apart',
          staged['totals']['actions']['blocked'], 2)
    check('every row carries its spreadsheet row number',
          all(row.get('source_row') for row in staged['rows']), True)
    check('the upload is attributed to whoever sent it',
          (client.get('/api/admin/roster-import', headers=admin).get_json() or [{}])[0]
          .get('uploaded_by_name'), 'Routes Admin')

    r = client.get(f'/api/admin/roster-import/{batch}', headers=admin)
    check('the batch can be read back', r.status_code, 200)
    check('and it is the same batch', (r.get_json() or {}).get('id'), batch)

    r = client.get('/api/admin/roster-import/999999', headers=admin)
    check('a batch that does not exist is 404', r.status_code, 404)

    # ── School aliases ───────────────────────────────────────────────────────
    r = client.get('/api/admin/school-aliases', headers=admin)
    aliases = r.get_json() or []
    check('every school the file named is offered',
          sorted(a['alias_norm'] for a in aliases), ['????', 'brown', 'glover'])
    unresolved = next(a for a in aliases if a['school_id'] is None)

    r = client.put(f'/api/admin/school-aliases/{unresolved["id"]}',
                   headers=admin, json={})
    check('resolving with neither a school nor a name is refused', r.status_code, 400)

    r = client.put('/api/admin/school-aliases/999999', headers=admin,
                   json={'school_name': 'Ghost School'})
    check('an alias that does not exist is 404', r.status_code, 404)

    r = client.put(f'/api/admin/school-aliases/{unresolved["id"]}',
                   headers=admin, json={'school_name': 'Village School'})
    check('a placeholder can be pointed at a new school', r.status_code, 200)
    check('and it stops being unresolved',
          (r.get_json() or {}).get('school_id') is not None, True)

    # Deliberate, and the reason the screen offers to read the file again: the
    # rows were staged as blocked and commit() does not revisit that decision.
    r = client.get(f'/api/admin/roster-import/{batch}', headers=admin)
    check('answering it does not retroactively unblock the staged rows',
          (r.get_json() or {})['totals']['actions']['blocked'], 2)

    # ── Commit ───────────────────────────────────────────────────────────────
    before = client.get('/api/admin/schools', headers=admin)
    check('staging alone created the named schools, not the placeholder',
          sorted(s['name'] for s in (before.get_json() or [])),
          ['Brown', 'Glover', 'Village School'])

    r = client.post(f'/api/admin/roster-import/{batch}/commit', headers=admin)
    check('the import applies', r.status_code, 200)
    applied = (r.get_json() or {}).get('applied') or {}
    check('with the counts the result screen reads',
          (applied.get('created'), applied.get('blocked')), (3, 2))
    check('and parent accounts reported separately',
          applied.get('parent_accounts_created'), 2)

    r = client.post(f'/api/admin/roster-import/{batch}/commit', headers=admin)
    check('a second commit is refused', r.status_code, 409)

    r = client.delete(f'/api/admin/roster-import/{batch}', headers=admin)
    check('and a committed batch cannot be discarded', r.status_code, 404)

    # ── Discarding one that was never applied ────────────────────────────────
    r = upload(client, admin)
    second = (r.get_json() or {}).get('id')
    r = client.delete(f'/api/admin/roster-import/{second}', headers=admin)
    check('an unwanted preview can be thrown away', r.status_code, 200)
    check('and it leaves the history marked, not deleted',
          next(b['status'] for b in client.get('/api/admin/roster-import', headers=admin)
               .get_json() if b['id'] == second), 'discarded')

    # ── Tenancy, through the routes rather than the functions ────────────────
    r = client.get(f'/api/admin/roster-import/{batch}', headers=auth(admin_id, bare))
    check("the other JCC cannot even see it exists", r.status_code, 403)

    with superadmin(cur):
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-routes','t-nomodule')")
        cur.execute("SELECT count(*) AS n FROM organizations WHERE slug LIKE 't-%'")
        check('the test cleans up after itself', cur.fetchone()['n'], 0)
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All roster import route checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
