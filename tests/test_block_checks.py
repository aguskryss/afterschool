"""The per-block confirmations are registered in every place that matters.

WHY THIS IS STATIC

    `block_checks` (sql/47) is a tenant table behind a module, which means it
    has to be declared in four separate files before it works, and three of the
    four failures are silent:

      • Missing from TENANT_TABLES  -> no organization_id, no org_isolation
        policy. The table works perfectly and every JCC reads every other JCC's
        headcounts.
      • Missing from MODULE_ROUTES  -> a JCC that never bought daily_ops can
        call the endpoint. tests/test_module_access.py already fails loudly on
        this one, which is why it is the exception.
      • Missing from init_db()      -> a database that never had sql/47 applied
        by hand never converges, and the endpoint 500s on a table that is not
        there.
      • Missing partial uniques     -> ON CONFLICT DO NOTHING has nothing to
        conflict against, so every tap inserts another row and the headcount
        climbs past the number of children in the room.

    The last one is the reason this file exists. Postgres accepts
    `ON CONFLICT DO NOTHING` with no matching index; it simply never
    de-duplicates. Nothing errors, nothing logs, and the only symptom is a
    number that is too big — on the screen a counselor uses to decide whether a
    child is missing.

    python3 tests/test_block_checks.py
"""

import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

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


tenancy = read('server', 'tenancy.py')
database = read('server', 'database.py')
app_py = read('server', 'app.py')

# ─── 1. Isolation ─────────────────────────────────────────────────────────

print("\nThe table is tenant-scoped")

tenant_tables = re.search(r'TENANT_TABLES = \((.*?)\n\)', tenancy, re.S)
check(
    "'block_checks' is in TENANT_TABLES",
    bool(tenant_tables) and "'block_checks'" in tenant_tables.group(1),
    "without it the table has no organization_id and no org_isolation policy",
)
check(
    "the .sql does not add organization_id by hand",
    'organization_id' not in read('sql', '47_add_block_checks.sql')
        .split('CREATE TABLE')[1].split(');')[0],
    "tenancy owns that column; a hand-added one drifts from the policy",
)

# ─── 2. Module gating ─────────────────────────────────────────────────────

print("\nThe endpoint belongs to daily_ops")

check(
    "('/api/counselor/block-checks', 'daily_ops') is in MODULE_ROUTES",
    "('/api/counselor/block-checks', 'daily_ops')" in tenancy,
    "a JCC without daily_ops has no classes and no care rooms to confirm in",
)

# ─── 3. init_db converges ─────────────────────────────────────────────────

print("\ninit_db() builds the same thing sql/47 does")

check(
    "init_db creates block_checks",
    'CREATE TABLE IF NOT EXISTS block_checks' in database,
    "a database that never had sql/47 applied would never get the table",
)
for constraint in ('block_checks_target_check',
                   'block_checks_room_block_check',
                   'block_checks_class_block_check'):
    check(f"init_db carries {constraint}", constraint in database)

# ─── 4. The uniques ON CONFLICT rests on ──────────────────────────────────

print("\nThe partial uniques exist, and are the ones the writes need")

uniques = re.search(
    r"for name, cols in \(\s*\('class_unique'.*?\n        \"\"\"\)",
    database, re.S,
)
check(
    "init_db creates block_checks_class_unique and block_checks_room_unique",
    bool(uniques),
    "without them ON CONFLICT DO NOTHING de-duplicates nothing, silently",
)
if uniques:
    body = uniques.group(0)
    check(
        "both are keyed on (organization_id, child_id, check_date, target)",
        'organization_id, child_id, check_date' in body,
        "a unique without organization_id would collide across JCCs",
    )
    check(
        "the room index includes time_block",
        "'room_id, time_block'" in body,
        "a care room is confirmed per hour; without it 3-4 and 4-5 collide",
    )
    check(
        "neither index includes id",
        not re.search(r'\bid\)', body),
        "including the primary key makes every row unique and the ON CONFLICT dead",
    )

# ─── 5. The write path cannot be pointed at somebody else's block ─────────

print("\nA counselor can only confirm in their own blocks")

writer = app_py.split('def counselor_set_block_checks(')[1].split('\n@app.route')[0]
check(
    "the POST resolves the counselor's own slots",
    '_my_slots(' in writer,
    "otherwise a client-supplied block id writes into another room",
)
check(
    "…and refuses a block that is not among them",
    re.search(r'not in _my_slots\(.*?\).*?403', writer, re.S) is not None,
    "the guard has to reject, not just compute",
)
check(
    "the identity comes from the token, never from the payload",
    "get_jwt_identity()" in writer and "payload.get('counselor" not in writer,
)

reader = app_py.split('def counselor_block_checks(')[1].split('\n@app.route')[0]
check(
    "the GET is bounded by those same slots",
    '_my_slots(' in reader,
    "reading another block's confirmations leaks who is in it",
)

# ─── 6. Rollback exists and is paired ─────────────────────────────────────

print("\nThe migration has a rollback")

check(
    "sql/48_rollback_block_checks.sql exists",
    os.path.exists(os.path.join(ROOT, 'sql', '48_rollback_block_checks.sql')),
)
rollback = read('sql', '48_rollback_block_checks.sql')
for obj in ('block_checks_class_unique', 'block_checks_room_unique',
            'DROP TABLE IF EXISTS public.block_checks'):
    check(f"the rollback drops {obj}", obj in rollback)


print(f"\n{checks - len(failures)}/{checks} checks passed")
if failures:
    print("FAILED: " + ", ".join(failures))
    sys.exit(1)
print("Per-block confirmations are wired up in all four places.")
