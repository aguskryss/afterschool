"""Per-organization email identity.

Two properties, and they fail in opposite directions.

THE DOMAIN CANNOT BE ESCAPED
    Mail from this platform is signed by a domain we verified with Resend. If
    an organization could choose the whole address rather than just the part
    before the @, it could send as another JCC or as Kikar and the signature
    would still check out. That is not a validation bug you notice in testing;
    it is one you notice when a parent forwards a phishing complaint. The
    guarantee is structural — the column holds a local part and the domain is
    appended — so these tests try to break it with input rather than trusting
    the endpoint to have validated.

EVERY SEND CARRIES AN IDENTITY
    The identity has to be resolved in request context and passed down, because
    two of the three places that send mail run in threads with no flask.g and
    no organization pin. A lookup done at send time would not crash there — it
    would quietly fall back to Kikar's branding and send. So `identity` is a
    required argument on every send function, and this file checks statically
    that no call site omits it, including the one that hands the work to a bare
    threading.Thread.

Reads app.py as text rather than importing it, like tests/test_module_access.py:
importing the app runs init_db() and needs a live database, and none of what is
checked here is a runtime property.

    python3 tests/test_org_email_identity.py
"""

import ast
import io
import os
import re
import sys
import tokenize

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import tenancy

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
APP_PY = os.path.join(ROOT, 'server', 'app.py')
TENANCY_PY = os.path.join(ROOT, 'server', 'tenancy.py')
SQL_41 = os.path.join(ROOT, 'sql', '41_add_org_email_identity.sql')

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


# ─── 1. The sender address, as a pure function ────────────────────────────

print("\norg_from_email(): the slug is the fallback, the domain is fixed")

domain = tenancy.EMAIL_SENDER_DOMAIN

check(
    "an unconfigured organization sends from its slug",
    tenancy.org_from_email(None, 'jccns') == f'jccns@{domain}',
    f"got {tenancy.org_from_email(None, 'jccns')!r}",
)
check(
    "email_from_local overrides the slug",
    tenancy.org_from_email('afterschool', 'jccns') == f'afterschool@{domain}',
)
check(
    "case and surrounding space are normalised",
    tenancy.org_from_email('  JCCNS  ', 'ignored') == f'jccns@{domain}',
)
check(
    "an organization with neither gets no address, not a malformed one",
    tenancy.org_from_email(None, None) is None,
)
check(
    "an empty override falls back rather than producing @domain",
    tenancy.org_from_email('', 'jccns') == f'jccns@{domain}',
)


# ─── 2. The domain cannot be escaped ──────────────────────────────────────

print("\nNo input produces mail from a domain other than ours")

# Each of these is an attempt to get the sender onto a different domain, by
# closing the local part early, by injecting a header, or by exploiting a
# permissive regex. None may produce an address outside EMAIL_SENDER_DOMAIN.
ATTACKS = [
    'evil@attacker.com',
    'noreply@kikarlabs.com',
    'a@b',
    'x"@attacker.com',
    'x\n@attacker.com',
    'x\r\nBcc: victim@example.com',
    'x@attacker.com#',
    'x%40attacker.com',
    '<script>alert(1)</script>',
    'x attacker.com',
    'x;attacker.com',
    '../../etc/passwd',
    'a' * 200,
    'ADMIN@KIKARLABS.COM',
]

for attempt in ATTACKS:
    result = tenancy.org_from_email(attempt, 'jccns')
    safe = result is None or (
        result.endswith(f'@{domain}') and result.count('@') == 1
    )
    check(
        f"rejected or contained: {attempt[:38]!r}",
        safe,
        f"produced {result!r}",
    )

check(
    "a slug can never be a whole address either",
    tenancy.org_from_email(None, 'evil@attacker.com') is None,
)


# ─── 3. Python and SQL enforce the same rule ──────────────────────────────

print("\nThe regex in Python and the CHECK in SQL agree")

sql = open(SQL_41, encoding='utf-8').read()
tenancy_src = open(TENANCY_PY, encoding='utf-8').read()

check(
    "sql/41 constrains email_from_local with the same pattern as EMAIL_LOCAL_PART_RE",
    tenancy.EMAIL_LOCAL_PART_RE.pattern in sql,
    f"{tenancy.EMAIL_LOCAL_PART_RE.pattern!r} not found in sql/41",
)
check(
    "init_db() mirrors the same constraint (CLAUDE.md §6)",
    tenancy.EMAIL_LOCAL_PART_RE.pattern in tenancy_src
    and 'organizations_email_from_local_check' in tenancy_src,
)
check(
    "sql/41 adds all three columns",
    all(
        f'ADD COLUMN IF NOT EXISTS {col}' in sql
        for col in ('email_from_local', 'email_from_name', 'email_reply_to')
    ),
)
check(
    "init_db() adds all three columns too",
    all(
        f'ADD COLUMN IF NOT EXISTS {col}' in tenancy_src
        for col in ('email_from_local', 'email_from_name', 'email_reply_to')
    ),
)

rollback = open(
    os.path.join(ROOT, 'sql', '42_rollback_org_email_identity.sql'), encoding='utf-8'
).read()
check(
    "the rollback drops what the migration added",
    all(
        f'DROP COLUMN IF EXISTS {col}' in rollback
        for col in ('email_from_local', 'email_from_name', 'email_reply_to')
    ),
)


# ─── 4. Every send carries an identity ────────────────────────────────────

print("\nNo call site sends mail without an identity")

source = open(APP_PY, encoding='utf-8').read()
tree = ast.parse(source)

# name -> how many positional arguments it must receive
SENDERS = {
    'send_email': 4,
    'send_email_async': 4,
    '_send_via_resend': 4,
    '_send_via_smtp': 4,
    'send_invitation': 4,
    'send_counselor_invitation': 4,
    'send_admin_invitation': 4,
    '_send_invitation_via': 5,
}

defs = {
    node.name: node
    for node in ast.walk(tree)
    if isinstance(node, ast.FunctionDef) and node.name in SENDERS
}

for name, arity in SENDERS.items():
    node = defs.get(name)
    check(
        f"{name}() is defined and takes an identity",
        node is not None and len(node.args.args) == arity,
        f"expected {arity} parameters, got "
        f"{len(node.args.args) if node else 'no definition'}",
    )
    if node is not None:
        check(
            f"{name}()'s last parameter is named `identity`",
            node.args.args[-1].arg == 'identity',
            f"last parameter is {node.args.args[-1].arg!r}",
        )
        check(
            f"{name}() has no default for identity — omitting it must be an error",
            not node.args.defaults,
            "a default would let a call site silently send with platform branding",
        )

bad_calls = []
for node in ast.walk(tree):
    if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Name):
        continue
    name = node.func.id
    if name not in SENDERS:
        continue
    supplied = len(node.args) + len(node.keywords)
    if supplied < SENDERS[name]:
        bad_calls.append(f"{name}() at app.py:{node.lineno} passes {supplied}")

check(
    "every call passes an identity",
    not bad_calls,
    '; '.join(bad_calls),
)

# The trap this whole design exists for: send_email_async hands send_email to a
# thread that has neither flask.g nor an organization pin. If the args tuple
# were built with three elements the call would fail at runtime, inside a
# daemon thread, where nothing surfaces it.
async_def = defs.get('send_email_async')
thread_args = None
if async_def is not None:
    for node in ast.walk(async_def):
        if (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr == 'Thread'
        ):
            for kw in node.keywords:
                if kw.arg == 'args' and isinstance(kw.value, ast.Tuple):
                    thread_args = kw.value.elts

check(
    "send_email_async forwards all four arguments into the thread",
    thread_args is not None and len(thread_args) == 4,
    f"thread args tuple has {len(thread_args) if thread_args else 'none'}",
)
check(
    "…and the fourth is the identity it was handed, not a fresh lookup",
    thread_args is not None
    and isinstance(thread_args[-1], ast.Name)
    and thread_args[-1].id == 'identity',
)


# ─── 5. Nothing resolves an identity inside a send function ───────────────

print("\nIdentity is resolved by the caller, never at send time")

for name in ('send_email', '_send_via_resend', '_send_via_smtp'):
    node = defs.get(name)
    calls_resolver = node is not None and any(
        isinstance(n, ast.Call)
        and isinstance(n.func, ast.Name)
        and n.func.id in ('email_identity', '_ambient_org_id', 'current_org_id')
        for n in ast.walk(node)
    )
    check(
        f"{name}() does not look the organization up itself",
        not calls_resolver,
        "resolving here would silently produce platform branding in a bare thread",
    )


# ─── 6. Templates no longer hardcode the platform's name ──────────────────

print("\nTemplates read the organization, not a constant")

TEMPLATED = (
    '_build_invitation_html',
    'send_counselor_invitation',
    'send_admin_invitation',
    '_email_shell',
)
template_defs = {
    node.name: node
    for node in ast.walk(tree)
    if isinstance(node, ast.FunctionDef) and node.name in TEMPLATED
}

for name in TEMPLATED:
    node = template_defs.get(name)
    body = ast.get_source_segment(source, node) if node else ''
    check(
        f"{name}() does not hardcode 'Kikar Afterschool'",
        node is not None and 'Kikar Afterschool' not in body,
    )

shell = template_defs.get('_email_shell')
shell_body = ast.get_source_segment(source, shell) if shell else ''
check(
    "_email_shell paints the header with the organization's brand colour",
    'identity.brand_primary' in shell_body,
)
check(
    "_email_shell renders the organization's logo when it has one",
    'identity.logo_url' in shell_body,
)

# Reply-To has to be conditional on both paths: Resend rejects an empty string
# outright rather than ignoring it, and an empty header is not the same as none.
for name in ('_send_via_resend', '_send_via_smtp', '_send_invitation_via'):
    node = defs.get(name)
    body = ast.get_source_segment(source, node) if node else ''
    check(
        f"{name}() sets Reply-To only when the organization has one",
        'if identity.reply_to' in body,
    )


# ─── 7. The superadmin route is the only writer ───────────────────────────

print("\nOnly superadmin can write the sender")

superadmin_src = open(os.path.join(ROOT, 'server', 'superadmin.py'), encoding='utf-8').read()

check(
    "the superadmin PATCH accepts the three fields",
    all(
        f"'{col}'" in superadmin_src
        for col in ('email_from_local', 'email_from_name', 'email_reply_to')
    ),
)
check(
    "it validates the local part against the shared regex",
    'EMAIL_LOCAL_PART_RE' in superadmin_src,
)
check(
    "it validates reply-to against the shared address regex",
    'EMAIL_ADDRESS_RE' in superadmin_src,
)
# app.py is the organization-scoped half of the application: every route in it
# runs with a tenant pinned. It may read the sender columns and must never write
# them, or the superadmin-only guarantee above would have a second door. Rather
# than pattern-match SQL, pin down *where* the names may appear at all: inside
# email_identity(), which is the one function that reads them.
identity_fn = next(
    (n for n in ast.walk(tree)
     if isinstance(n, ast.FunctionDef) and n.name == 'email_identity'),
    None,
)
check("email_identity() exists", identity_fn is not None)

if identity_fn is not None:
    span = range(identity_fn.lineno, (identity_fn.end_lineno or identity_fn.lineno) + 1)
    # Comments are skipped deliberately: prose that explains the rule is not a
    # use of the columns, and a check that cannot tell the two apart would
    # punish documenting the thing it protects. Tokenizing rather than
    # stripping `#` by hand, so a hash inside a string literal is not mistaken
    # for one.
    stray = sorted({
        tok.start[0]
        for tok in tokenize.generate_tokens(io.StringIO(source).readline)
        if tok.type not in (tokenize.COMMENT, tokenize.NL)
        and tok.start[0] not in span
        and any(col in tok.string for col in
                ('email_from_local', 'email_from_name', 'email_reply_to'))
    })
    check(
        "the sender columns are used nowhere in app.py but email_identity()",
        not stray,
        f"also at line(s) {', '.join(map(str, stray))} — app.py must only read these",
    )

check(
    "no route in app.py writes the columns in SQL",
    not re.search(
        r'(UPDATE|INSERT)[^;]*?email_(from_local|from_name|reply_to)',
        source,
        re.S | re.I,
    ),
)


# ─── Result ───────────────────────────────────────────────────────────────

print(f"\n{checks - len(failures)}/{checks} checks passed")
if failures:
    print("\nFailed:")
    for f in failures:
        print(f"  · {f}")
    sys.exit(1)
print("Per-organization email identity holds.")
