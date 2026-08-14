# Smoke tests — Flask backend after RLS migration

Goal: confirm the Flask backend behaves identically before and after
the RLS migration. Because the backend uses the `postgres` role
(BYPASSRLS), every endpoint should return exactly the same data.

Run all of these **right after** applying `01_enable_rls_deny_all.sql`,
ideally on staging first if you have one, otherwise immediately after
the production deploy with a real test account in hand.

## Setup

```bash
export BASE="https://YOUR-RENDER-APP.onrender.com"   # or staging URL
# Have credentials for one of each role ready:
#   - parent_test@example.com / <pw>
#   - counselor_test@example.com / <pw>
#   - admin_test@example.com / <pw>
```

Helper to extract the token from a login response:

```bash
login() {
  curl -s -X POST "$BASE/api/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$1\",\"password\":\"$2\"}" \
    | python3 -c 'import sys,json;d=json.load(sys.stdin);print(d.get("token",""))'
}
```

---

## Critical path 1 — Login (every role)

Read paths into `users` + `user_totp` + `login_attempts`. Writes to
`login_attempts`, `users.password_set_at`.

```bash
PARENT_TOKEN=$(login parent_test@example.com 'YourPassword!')
[ -n "$PARENT_TOKEN" ] && echo "parent login OK" || echo "FAIL"

COUNSELOR_TOKEN=$(login counselor_test@example.com 'YourPassword!')
[ -n "$COUNSELOR_TOKEN" ] && echo "counselor login OK" || echo "FAIL"

ADMIN_TOKEN=$(login admin_test@example.com 'YourPassword!')
[ -n "$ADMIN_TOKEN" ] && echo "admin login OK" || echo "FAIL"
```

All three must print `OK`. If any fails, run rollback.

## Critical path 2 — Wrong password is still rejected

Confirms `login_attempts` writes still work (rate limiting depends on it).

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST "$BASE/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"parent_test@example.com","password":"definitely-wrong"}'
# Expected: 401
```

## Critical path 3 — Parent sees only their own children

Touches `children`, `registrations`, `absences`, `schools`. The
ownership filter (`WHERE parent_id = %s`) is in SQL, not RLS.

```bash
curl -s "$BASE/api/parent/children" \
  -H "Authorization: Bearer $PARENT_TOKEN" | python3 -m json.tool | head -30
# Expected: array of children belonging to the parent. Same content as
# before the migration. Confirm count and names match.
```

## Critical path 4 — Parent marks an absence (write path)

Writes to `absences`. Validates `child_id` ownership against `children`.

```bash
# Replace 123 with a real child_id from the previous response.
curl -s -X POST "$BASE/api/parent/absences" \
  -H "Authorization: Bearer $PARENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"child_id": 123, "date": "2026-05-15"}'
# Expected: {"message":"Absence marked"}

# Cleanup so we don't leave test data.
curl -s -X DELETE "$BASE/api/parent/absences" \
  -H "Authorization: Bearer $PARENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"child_id": 123, "date": "2026-05-15"}'
# Expected: {"message":"Absence removed"}
```

## Critical path 5 — Counselor sees roster + records attendance

Reads `children` + `schools` + `counselor_schools`. Writes to
`attendance_records`.

```bash
TODAY=$(date +%Y-%m-%d)

curl -s "$BASE/api/counselor/roster?date=$TODAY" \
  -H "Authorization: Bearer $COUNSELOR_TOKEN" | python3 -m json.tool | head -40
# Expected: roster with the schools this counselor is assigned to.

# (Skip the actual attendance write unless you have a clean test child;
# that path is exercised daily in production and is the same SQL as
# before — what we need to verify is that read still works.)
```

## Critical path 6 — Pickup notification flow

This is the highest-traffic write path. SSE + `pickup_notifications`
inserts/updates.

```bash
# Parent triggers pickup (replace child_id):
curl -s -X POST "$BASE/api/parent/pickup" \
  -H "Authorization: Bearer $PARENT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"child_id": 123}'
# Expected: 200 with notification id.

# Counselor lists alerts:
curl -s "$BASE/api/counselor/pickup-alerts" \
  -H "Authorization: Bearer $COUNSELOR_TOKEN" | python3 -m json.tool | head -20
# Expected: includes the pickup just created.
```

## Critical path 7 — Password reset (touches password_reset_tokens)

This is one of the tables the Security Advisor flagged as critical.
Confirm the flow still works end-to-end.

```bash
# Request a reset (writes to password_reset_tokens).
curl -s -X POST "$BASE/api/auth/forgot-password" \
  -H "Content-Type: application/json" \
  -d '{"email":"parent_test@example.com"}'
# Expected: generic success message regardless of whether the email exists
# (do not leak account existence). Then check email inbox for the link,
# OR query the DB in SQL Editor:
#   SELECT id, user_id, used, expires_at FROM password_reset_tokens
#   ORDER BY created_at DESC LIMIT 3;
# Expected: a fresh row with used=0.
```

Don't actually consume the token unless you intend to change the test
password. Just verifying the row was written is enough.

## Critical path 8 — Admin endpoints

Admin reads aggregate everything. If any RLS misconfig leaks through,
admin queries are where it shows up first.

```bash
curl -s "$BASE/api/admin/stats" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool
# Expected: same numbers as pre-migration.

curl -s "$BASE/api/admin/parents" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool | head -20
# Expected: list of parents.

curl -s "$BASE/api/admin/attendance?date=$TODAY" \
  -H "Authorization: Bearer $ADMIN_TOKEN" | python3 -m json.tool | head -20
# Expected: today's attendance records.
```

## Critical path 9 — Push subscriptions + VAPID

`app_settings` has VAPID keys. If the backend can't read it, push
notifications break silently.

```bash
curl -s "$BASE/api/push/vapid-public-key" | python3 -m json.tool
# Expected: {"key":"BMt..."}   (the public VAPID key string)
# If this returns null/empty, RLS is blocking the postgres role
# somewhere — abort.
```

---

## Acceptance criteria

All of the following must be true after the migration:

- [ ] All three role logins succeed
- [ ] Wrong-password login returns 401
- [ ] Parent sees their children with the same row count as before
- [ ] Parent can write + delete an absence
- [ ] Counselor sees roster
- [ ] Parent → counselor pickup flow works end-to-end
- [ ] Forgot-password writes a row to `password_reset_tokens`
- [ ] Admin stats / parents / attendance return non-empty data
- [ ] `/api/push/vapid-public-key` returns the key

If any one of these fails, run `02_rollback_disable_rls.sql`
immediately and investigate before re-applying.

## What to do if Flask suddenly returns empty results

Symptom: smoke tests return `[]` or "Child not found" where data
exists.

Diagnosis: the Flask DATABASE_URL is connecting with a role that does
NOT bypass RLS. Confirm:

```sql
-- Run in Supabase SQL Editor:
SELECT current_user, rolbypassrls FROM pg_roles
WHERE rolname = current_user;
```

If `rolbypassrls = false`, that role is the connection role and is
being filtered by RLS. Two fixes:

1. Switch DATABASE_URL in Render to use the `postgres` role connection
   string from Supabase (recommended).
2. As superuser, grant BYPASSRLS:
   `ALTER ROLE <rolename> BYPASSRLS;`

Either way, run the rollback first to unblock production, then fix the
role, then re-apply the migration.
