"""No second front door.

The product has one login. `/api/auth/login` returns the role and the SPA routes
on it — that is written down in CLAUDE.md §3 as a constraint, and this file is
what makes it enforceable instead of remembered.

WHAT WENT WRONG, SO THE SHAPE OF THESE CHECKS MAKES SENSE
    `public/admin/index.html` is the legacy admin, kept alive because the
    activity-roster and end-of-year tools were never rebuilt. It also carried a
    complete parallel login: its own email and password fields, its own 2FA
    input, its own call to /api/auth/login, its own "This portal is for
    administrators only" rejection, and a link offering to go "back to portal
    selection" — a concept deleted long ago.

    Nothing linked to it, which is why it survived. Then the password-reset page
    was found mapping roles onto per-portal URLs (`admin` → `/admin`), so every
    administrator who set a password was delivered straight to that old screen.
    Two dormant things pointed at each other and became a live path.

    So these checks do not just test the reset page. They test that the legacy
    page has no login surface left to land on, that no page links a person to a
    legacy route, and that no new hand-written portal appears beside them.

    python3 tests/test_no_legacy_portals.py
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PUBLIC = os.path.join(ROOT, 'public')
APP_PY = os.path.join(ROOT, 'server', 'app.py')

failures = []
checks = 0


def check(label, condition, detail=''):
    global checks
    checks += 1
    if condition:
        print(f"  ok   {label}")
    else:
        print(f"  FAIL {label}" + (f"\n         {detail}" if detail else ''))
        failures.append(label)


def read(*parts):
    with open(os.path.join(ROOT, *parts), encoding='utf-8') as fh:
        return fh.read()


def strip_comments(text):
    """Code only — prose about the rule is not a violation of it.

    Without this, the comment explaining that doLogin() was deleted counts as
    evidence that doLogin() is still there, and the honest thing to do (leave a
    note saying why the login is gone) would be the thing that fails the test.

    Not a parser: a `//` inside a string literal truncates the rest of that
    line. Every check that uses this has a second, structural net — an element
    id or an attribute — so a miss here does not become a pass.
    """
    text = re.sub(r'<!--.*?-->', '', text, flags=re.S)
    text = re.sub(r'/\*.*?\*/', '', text, flags=re.S)
    return re.sub(r'(?<!:)//[^\n]*', '', text)


# ─── 1. No new hand-written pages ─────────────────────────────────────────

print("\nThe set of hand-written HTML pages does not grow")

# public/app/ is the compiled SPA and is gitignored — it is generated, not
# written, so it is not part of this inventory.
#
# ADDING A FILE HERE IS A DECISION, NOT A FORMALITY. Every entry is a page
# outside the SPA with its own markup, its own styling and its own idea of what
# the product looks like. That is exactly how the admin portal drifted into
# being a second product. If you are about to add one, the question to answer
# first is why it is not a route in web/src/routes/.
ALLOWED_PAGES = {
    # Password reset. Outside the SPA because it must work for someone who has
    # no session and, by definition, cannot sign in.
    'reset-password/index.html',
    # The legacy admin. Alive only for activity-roster and end-of-year, which
    # have not been rebuilt. It has no login of its own — see section 2.
    'admin/index.html',
}

found = set()
for dirpath, dirnames, filenames in os.walk(PUBLIC):
    dirnames[:] = [d for d in dirnames if d != 'app']
    for filename in filenames:
        if filename.endswith(('.html', '.htm')):
            rel = os.path.relpath(os.path.join(dirpath, filename), PUBLIC)
            found.add(rel.replace(os.sep, '/'))

unexpected = sorted(found - ALLOWED_PAGES)
check(
    "no HTML page outside the allowlist",
    not unexpected,
    f"new page(s): {', '.join(unexpected)} — should this be a route in the SPA?",
)
missing = sorted(ALLOWED_PAGES - found)
check(
    "the allowlist has no stale entries",
    not missing,
    f"listed but absent: {', '.join(missing)} — remove from ALLOWED_PAGES",
)


# ─── 2. The legacy admin cannot sign anyone in ────────────────────────────

print("\nThe legacy admin has no login surface")

admin_html = read('public', 'admin', 'index.html')
admin_code = strip_comments(admin_html)

# NOT "no password input". This page legitimately has several — changing your
# own password, disabling 2FA, confirming a destructive wipe. Those are things
# an already-authenticated admin does, and forbidding them would be testing the
# wrong property. What must not exist is a form that turns credentials into a
# session, so the checks below look for that specifically.
check(
    "no element belongs to a login form",
    not re.search(r'id="login-[a-z]+"', admin_code),
    "ids like login-email / login-password are a sign-in form",
)
check(
    "no login view element",
    'id="login-view"' not in admin_code
    and "getElementById('login-view')" not in admin_code,
)
check(
    "no 2FA challenge of its own",
    'id="login-totp"' not in admin_code and 'id="totp-group"' not in admin_code,
    "2FA at sign-in belongs to the SPA; this is not where you prove who you are",
)
check(
    "it does not call the login endpoint",
    '/api/auth/login' not in admin_code,
    "authentication belongs to the SPA and only to the SPA",
)
check(
    "no doLogin() handler",
    not re.search(r'function\s+doLogin\s*\(', admin_code),
)
check(
    "nothing offers to go back to portal selection",
    'portal selection' not in admin_code.lower(),
    "the portal-selection screen was removed; a link to it is a fossil",
)
check(
    "an unauthenticated visitor is sent to the app's login",
    "'/app/login'" in admin_code,
)
check(
    "logout clears the app session too, or the bridge walks straight back in",
    "removeItem('kikar_auth')" in admin_code,
)


# ─── 3. Nothing sends a person to a legacy route ──────────────────────────

print("\nNo page links a person to /parent, /counselor or /admin")

# The routes still exist server-side: /parent and /counselor redirect into the
# SPA, and /admin serves the legacy tools. What must not exist is markup or
# script that *sends* somebody there, because that is how a redirect chain ends
# on a page nobody meant to show.
LEGACY_TARGET = re.compile(
    r'''(?:href|window\.location(?:\.href|\.replace)?\s*=|window\.open)\s*'''
    r'''[=(]?\s*["']/(parent|counselor|admin)(?:/|["'])''',
    re.I,
)

for page in sorted(ALLOWED_PAGES):
    html = read('public', *page.split('/'))
    hits = [m.group(0) for m in LEGACY_TARGET.finditer(html)]
    check(
        f"public/{page} links to no legacy portal",
        not hits,
        f"found {hits}",
    )

reset_html = read('public', 'reset-password', 'index.html')
check(
    "the reset page has no role-to-portal map",
    'portalByRole' not in reset_html,
    "the SPA already routes by role; this page should not know roles exist",
)
check(
    "the reset page sends everyone to /app/login",
    "'/app/login'" in reset_html,
)


# ─── 4. Server-side routes behave ─────────────────────────────────────────

print("\nThe server keeps the legacy routes harmless")

app_py = read('server', 'app.py')

check(
    "/parent and /counselor redirect instead of serving a page",
    re.search(
        r"@app\.route\('/parent'\)(.|\n)*?def legacy_portal_redirect\(\)(.|\n)*?redirect\('/app/'",
        app_py,
    )
    is not None,
)

# A push notification is a link someone taps on a phone. Pointing one at a
# legacy route means the tap lands on a redirect at best, and on the old portal
# at worst — which is precisely the failure this file exists for.
push_targets = re.findall(r"send_push_to_user(?:_async)?\((?:[^()]|\([^()]*\))*?\)", app_py)
bad_push = [
    t for t in push_targets
    if re.search(r"""["']/(parent|counselor|admin)(?:/|["'])""", t)
]
check(
    "no push notification points at a legacy route",
    not bad_push,
    f"{len(bad_push)} found: {bad_push[:2]}",
)

# The emails go to real parents, so a wrong link here is the most expensive
# version of this mistake. /reset-password is allowed: it is a real page in the
# allowlist above, and it has to work for someone with no session at all.
email_links = re.findall(r"base_url'\]\}(/[a-z/-]*)", app_py)
check(
    "email links point into the SPA or at the reset page",
    all(
        link.startswith('/app') or link in ('/', '/reset-password')
        for link in email_links
    ),
    f"found {sorted(set(email_links))}",
)


# ─── 5. One session key, one login ────────────────────────────────────────

print("\nOne session, one login")

check(
    "the legacy page only reads and clears the session, never writes it",
    not re.search(r"setItem\(\s*['\"]kikar_auth", admin_code),
    "writing kikar_auth here would make this page a session authority again",
)
check(
    "…and it does touch it, so the bridge has not been quietly removed",
    "getItem('kikar_auth')" in admin_code,
)
check(
    "no page outside the SPA re-creates per-role session namespaces",
    not any(
        re.search(r"jclub_(token|refresh|name)_(parent|counselor)\b", read('public', *p.split('/')))
        and p != 'admin/index.html'
        for p in ALLOWED_PAGES
    ),
)


# ─── Result ───────────────────────────────────────────────────────────────

print(f"\n{checks - len(failures)}/{checks} checks passed")
if failures:
    print("\nFailed:")
    for f in failures:
        print(f"  · {f}")
    sys.exit(1)
print("There is one front door.")
