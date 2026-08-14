"""Per-organization branding: the logo and the two brand colours.

Three properties, and they fail in different places.

THE LOGO RESOLVES IN ONE ORDER, EVERYWHERE
    Two columns can supply it — `logo_path`, a file in a bucket we own, and
    `logo_url`, a link to an image on the JCC's own website. Every caller has
    to agree on which wins, or the app shows one logo and the invitation email
    shows another. tenancy.org_logo_url() is the single answer and this pins
    its precedence.

STORAGE PATHS STAY INSIDE THEIR ORGANIZATION
    Object keys are built, not supplied, and every one is prefixed with the
    organization id. That is what keeps a path-handling bug from letting one
    JCC's upload land on another's logo.

ONLY A SUPERADMIN CAN CHANGE IT
    Branding is not dangerous the way the mail sender is — nobody gets phished
    by a logo — but the routes live in the platform console and an
    organization admin reaching them would be a surprise, so it is checked.

The upload path itself is not exercised: it posts to Supabase, and a test that
needs the network to pass is a test that fails for reasons that are not the
code. What is checked is everything around it — validation, precedence,
authorization — plus that an unconfigured Supabase degrades to a wordmark
rather than a 500 on every request that reads an organization.

Run against a local database:

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:local-dev-only@localhost:5432/kikar \
    JWT_SECRET_KEY=test-secret \
    python3 tests/test_org_branding.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import brand_storage, database, tenancy  # noqa: E402
from server.app import app  # noqa: E402
from flask_jwt_extended import create_access_token  # noqa: E402

failures: list[str] = []


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


def auth(org_id, role='superadmin'):
    with app.app_context():
        tok = create_access_token(
            identity='1', additional_claims={'role': role, 'org': org_id})
    return {'Authorization': f'Bearer {tok}'}


def main() -> int:
    if not database.DATABASE_URL:
        print('DATABASE_URL is not set; skipping.')
        return 0

    app.config['TESTING'] = True
    client = app.test_client()

    # ── Path building: keys are ours, and they are per organization ───────
    print("\nObject keys are built, never supplied")

    p = brand_storage.build_path(7, 'Logo Final v2.PNG')
    check('the key is prefixed with the organization', p.startswith('org-7/'), True)
    check('and the extension is normalised', p.endswith('.png'), True)
    check('two uploads never collide',
          brand_storage.build_path(7, 'a.png') != brand_storage.build_path(7, 'a.png'),
          True)
    check('a different organization gets a different prefix',
          brand_storage.build_path(8, 'a.png').startswith('org-8/'), True)

    # A filename is attacker-adjacent input in the general case: it comes from
    # whoever picked the file. None of these may produce a key that escapes the
    # organization's prefix.
    for hostile in ('../../org-1/logo.png', 'logo.png/../../x.png',
                    'a.png\n../b.png', '/etc/passwd.png'):
        key = brand_storage.build_path(7, hostile)
        check(f'contained: {hostile[:26]!r}',
              key.startswith('org-7/') and key.count('/') == 1, True)

    for bad in ('logo.exe', 'logo', 'logo.gif', 'logo.html'):
        try:
            brand_storage.build_path(7, bad)
            check(f'{bad} is rejected', 'accepted', 'StorageError')
        except brand_storage.StorageError:
            check(f'{bad} is rejected', 'StorageError', 'StorageError')

    # ── Size ──────────────────────────────────────────────────────────────
    print("\nA logo loads on every screen, so it is capped")
    try:
        brand_storage.upload('org-7/logo-x.png', b'x' * (brand_storage.MAX_BYTES + 1))
        check('oversized uploads are refused', 'accepted', 'StorageError')
    except brand_storage.StorageError as e:
        check('oversized uploads are refused', 'limit' in str(e).lower(), True)
    try:
        brand_storage.upload('org-7/logo-x.png', b'')
        check('an empty file is refused', 'accepted', 'StorageError')
    except brand_storage.StorageError as e:
        check('an empty file is refused', 'empty' in str(e).lower(), True)

    # ── The browser has to be allowed to load the thing ───────────────────
    #
    # The logo uploaded, the bucket was public, the URL was correct, and the
    # image still rendered broken: Content-Security-Policy said
    # `img-src 'self' data:`, so the browser refused an image from Supabase.
    # Nothing in the app could report that — a CSP violation is a console
    # warning in someone else's browser. The photo gallery had the same fault
    # and nobody had noticed, because `photos` is off by default.
    print("\nCSP allows the images this product actually shows")

    csp = client.get('/api/health').headers.get('Content-Security-Policy', '')
    img = next((d.strip() for d in csp.split(';') if d.strip().startswith('img-src')), '')
    check('there is an img-src directive', bool(img), True)
    check('IT ALLOWS REMOTE IMAGES, OR NO LOGO AND NO PHOTO EVER RENDERS',
          'https:' in img or 'supabase' in img, True)
    check('inline data URIs still work', 'data:' in img, True)
    check('and our own origin', "'self'" in img, True)
    # The directive that would actually matter is left alone by this test, but
    # asserted so widening it is a deliberate act rather than a side effect.
    #
    # Compared token by token, not by substring: the bare scheme source
    # `https:` is a different thing from `https://cdn.jsdelivr.net`, and a
    # substring check confuses the two — it reads the allowlist of three named
    # CDNs as "any host on the internet" and fails a policy that is fine.
    script = next((d.strip() for d in csp.split(';')
                   if d.strip().startswith('script-src')), '')
    check('script-src is not widened to any https host',
          'https:' not in script.split()[1:], True)
    check('…and img-src is, which is the difference being asserted',
          'https:' in img.split()[1:], True)

    # ── Storage errors have to name the fix ───────────────────────────────
    #
    # The first real upload attempt failed with
    #   Upload failed (400): {"statusCode":"404","error":"Bucket not found",...}
    # which is accurate and useless: it does not say which bucket, where to
    # make one, or that it has to be public. Worse, it came back as a 400,
    # which reads as "your image is wrong" for a problem that has nothing to do
    # with the image.
    print("\nA storage error says what to do about it")

    class FakeResponse:
        def __init__(self, status, payload, text=None):
            self.status_code = status
            self._payload = payload
            self.text = text if text is not None else str(payload)

        def json(self):
            if self._payload is None:
                raise ValueError('not json')
            return self._payload

    missing = brand_storage._explain(
        FakeResponse(400, {'statusCode': '404', 'error': 'Bucket not found',
                           'code': 'NoSuchBucket'}), 'brand')
    check('a missing bucket names the bucket', 'brand' in str(missing), True)
    check('and says to make it public', 'Public bucket' in str(missing), True)
    check('AND IS FLAGGED AS SETUP, NOT A BAD FILE', missing.setup, True)

    # The one that actually bit: the bucket existed, the upload succeeded, and
    # the image came back broken because the bucket was private. Uploading to a
    # private bucket works — only reading fails — so nothing complained.
    private = brand_storage._explain(
        FakeResponse(400, {'statusCode': '400', 'error': 'Bucket not public',
                           'message': 'Bucket not public',
                           'code': 'InvalidRequest'}), 'brand')
    check('a private bucket is diagnosed as private',
          'private' in str(private).lower(), True)
    check('and points at the exact toggle',
          'Public bucket' in str(private), True)
    check('and is a setup problem', private.setup, True)
    check('it is NOT reported as a missing bucket',
          'does not exist' in str(private), False)

    badkey = brand_storage._explain(
        FakeResponse(401, {'code': 'InvalidJWT'}), 'brand')
    check('a rejected key says which key', 'service_role' in str(badkey), True)
    check('and is a setup problem too', badkey.setup, True)

    unparseable = brand_storage._explain(FakeResponse(500, None, 'boom'), 'brand')
    check('an unrecognised failure still explains itself',
          '500' in str(unparseable), True)
    check('and does not crash on a non-JSON body', unparseable.setup, True)

    # The two that really are the file, and must stay 400-shaped.
    try:
        brand_storage.build_path(7, 'logo.exe')
    except brand_storage.StorageError as e:
        check('a wrong file type is NOT a setup problem', e.setup, False)
    try:
        brand_storage.upload('org-7/x.png', b'x' * (brand_storage.MAX_BYTES + 1))
    except brand_storage.StorageError as e:
        check('an oversized file is NOT a setup problem', e.setup, False)

    # ── Precedence, the property every caller depends on ──────────────────
    print("\nlogo_path wins, logo_url is the fallback, neither is a wordmark")

    check('no logo at all resolves to nothing',
          tenancy.org_logo_url({'logo_path': None, 'logo_url': None}), None)
    check('a blank pasted URL is not a logo',
          tenancy.org_logo_url({'logo_path': None, 'logo_url': '   '}), None)
    check('a pasted URL is used when there is no upload',
          tenancy.org_logo_url({'logo_path': None,
                                'logo_url': 'https://jcc.org/logo.png'}),
          'https://jcc.org/logo.png')

    configured = brand_storage.is_configured()
    resolved = tenancy.org_logo_url(
        {'logo_path': 'org-7/logo-abc.png', 'logo_url': 'https://jcc.org/old.png'})
    if configured:
        check('AN UPLOAD BEATS A PASTED URL',
              resolved is not None and resolved.endswith('org-7/logo-abc.png'), True)
        check('and it is served from the public path',
              '/object/public/' in (resolved or ''), True)
    else:
        # The interesting case for a deploy with no Supabase keys: the row says
        # there is an uploaded logo and there is no way to build its URL. This
        # must fall through rather than raise, or every screen 500s.
        check('WITHOUT SUPABASE, AN UPLOADED LOGO FALLS BACK INSTEAD OF RAISING',
              resolved, 'https://jcc.org/old.png')
        print('      (SUPABASE_URL not set — exercising the unconfigured path)')

    # ── The routes ────────────────────────────────────────────────────────
    print("\nOnly a superadmin can change a logo")

    conn = owner_conn()
    cur = conn.cursor(cursor_factory=database.psycopg2.extras.RealDictCursor)
    pin(cur, None, superadmin=True)
    cur.execute(
        "INSERT INTO organizations (slug, name, timezone) "
        "VALUES ('t-brand', 'Brand JCC', 'America/New_York') "
        "ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name RETURNING id")
    org = cur.fetchone()['id']

    for role in ('admin', 'counselor', 'parent'):
        check(f'a {role} cannot upload one',
              client.post(f'/api/superadmin/organizations/{org}/logo',
                          headers=auth(org, role)).status_code, 403)
        check(f'a {role} cannot delete one',
              client.delete(f'/api/superadmin/organizations/{org}/logo',
                            headers=auth(org, role)).status_code, 403)
    check('an unauthenticated request is rejected',
          client.post(f'/api/superadmin/organizations/{org}/logo').status_code, 401)

    # With no file attached the route must say so rather than 500. Skipped when
    # Supabase is unconfigured, because then the 503 fires first — which is
    # itself the correct answer and is checked below.
    if configured:
        check('a superadmin with no file attached gets a clear 400',
              client.post(f'/api/superadmin/organizations/{org}/logo',
                          headers=auth(None)).status_code, 400)
    else:
        check('WITHOUT STORAGE CONFIGURED THE ROUTE SAYS SO, NOT 500',
              client.post(f'/api/superadmin/organizations/{org}/logo',
                          headers=auth(None)).status_code, 503)

    # ── Delete is idempotent and reports the row back ─────────────────────
    print("\nRemoving a logo that is not there is not an error")
    r = client.delete(f'/api/superadmin/organizations/{org}/logo', headers=auth(None))
    check('delete succeeds', r.status_code, 200)
    check('and hands back the organization', r.get_json()['id'], org)
    check('with no uploaded logo', r.get_json()['logo_uploaded'], False)
    check('a missing organization is a 404',
          client.delete('/api/superadmin/organizations/999999/logo',
                        headers=auth(None)).status_code, 404)

    # ── The console needs to tell the two sources apart ───────────────────
    print("\nThe console can distinguish an upload from a pasted link")
    client.patch(f'/api/superadmin/organizations/{org}',
                 headers=auth(None), json={'logo_url': 'https://jcc.org/logo.png'})
    listed = next(o for o in client.get('/api/superadmin/organizations',
                                        headers=auth(None)).get_json()
                  if o['id'] == org)
    check('a pasted link shows as not uploaded', listed['logo_uploaded'], False)
    check('and is what the app will render',
          listed['logo_url'], 'https://jcc.org/logo.png')

    pin(cur, None, superadmin=True)
    cur.execute("UPDATE organizations SET logo_path = %s WHERE id = %s",
                ('org-%d/logo-test.png' % org, org))
    listed = next(o for o in client.get('/api/superadmin/organizations',
                                        headers=auth(None)).get_json()
                  if o['id'] == org)
    check('an upload shows as uploaded', listed['logo_uploaded'], True)
    if configured:
        check('and takes precedence in what is rendered',
              listed['logo_url'].endswith(f'org-{org}/logo-test.png'), True)

    # Cleanup
    pin(cur, None, superadmin=True)
    cur.execute("DELETE FROM organizations WHERE id = %s", (org,))
    check('cleanup removes the test organization', cur.rowcount, 1)
    cur.close()
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All branding checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
