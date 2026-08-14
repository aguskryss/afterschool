# Testing — verify PostgREST is actually locked down

The whole point of the migration is that an attacker armed with the
project URL + anon key gets nothing. These tests confirm that, both
before and after the migration, so you can see the difference.

## Prerequisites

You need three things from your Supabase dashboard:

1. **Project URL** — Settings → API → Project URL
   Looks like `https://abcdefghijklmnop.supabase.co`
   Save as `SUPA_URL`.

2. **anon key** — Settings → API → Project API keys → `anon` `public`
   Long JWT starting with `eyJhbGciOi...`
   Save as `ANON_KEY`.

3. **service_role key** — Settings → API → Project API keys → `service_role`
   `secret`. Used only to confirm the bypass path still works for
   trusted callers. **Treat as a password — never commit, never paste in
   chat, rotate if leaked.**
   Save as `SERVICE_KEY`.

```bash
export SUPA_URL="https://YOUR_PROJECT_REF.supabase.co"
export ANON_KEY="eyJ...your-anon-key..."
export SERVICE_KEY="eyJ...your-service-key..."   # only for one verification step
```

---

## Test 1 — BEFORE the migration: prove the hole exists

Run this **first**, against the live project, with RLS still off. Expect
data back — that's the bug we're fixing.

```bash
# Should return rows of children — this is the vulnerability.
curl -s "$SUPA_URL/rest/v1/children?select=id,name,school_id&limit=3" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" | head -c 500

# Should return rows from users including password_hash.
curl -s "$SUPA_URL/rest/v1/users?select=id,email,password_hash&limit=3" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" | head -c 500
```

If those return JSON arrays with real data → confirmed vulnerable, run
the migration. **Save the output for the post-migration comparison.**

If they already return `[]` or an error → either RLS got fixed by
someone else, or PostgREST grants were revoked previously. Stop and
investigate before applying the migration.

---

## Test 2 — AFTER the migration: prove the hole is closed

Run the **exact same commands** as Test 1. Expected results:

```bash
curl -s "$SUPA_URL/rest/v1/children?select=id,name&limit=3" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY"
# Expected: []   (empty array — RLS deny + grants revoked)
# OR:      {"code":"42501","message":"permission denied for table children"}

curl -s "$SUPA_URL/rest/v1/users?select=id,email,password_hash&limit=3" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY"
# Expected: same as above — empty array or 42501 permission denied.
```

**Test every sensitive table** — these are the ones that would matter
if leaked:

```bash
for table in users children password_reset_tokens user_totp \
             attendance_records absences parent_notifications \
             pickup_notifications login_attempts invitations \
             push_subscriptions registrations \
             pickup_claim_audit counselor_schools \
             schools activities activity_roster activity_schedules \
             calendar_events app_settings; do
  echo "=== $table ==="
  curl -s "$SUPA_URL/rest/v1/$table?select=*&limit=1" \
    -H "apikey: $ANON_KEY" \
    -H "Authorization: Bearer $ANON_KEY"
  echo
done
```

Every line must be either `[]` or a 42501 permission-denied error. **No
JSON object with real data may appear.** If even one table leaks, abort
and investigate.

---

## Test 3 — Writes are blocked too

Read access is the obvious risk; writes are equally critical. An
attacker without RLS could `DELETE` or `UPDATE` anything.

```bash
# Try to insert a fake user. Must fail.
curl -s -X POST "$SUPA_URL/rest/v1/users" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Content-Type: application/json" \
  -H "Prefer: return=minimal" \
  -d '{"email":"attacker@example.com","password_hash":"x","role":"admin","name":"x"}'
# Expected: 401 / 403 / 42501 — never 201.

# Try to delete absences. Must fail.
curl -s -X DELETE "$SUPA_URL/rest/v1/absences?id=gt.0" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY"
# Expected: empty / error. After running, double-check absences row count
# in SQL Editor: SELECT count(*) FROM absences;  — must be unchanged.
```

---

## Test 4 — service_role still works (do this once, then forget the key)

Trusted server-side callers using `service_role` must NOT be blocked,
because the role has BYPASSRLS. Confirm once, with a read-only query:

```bash
curl -s "$SUPA_URL/rest/v1/users?select=id,email&limit=1" \
  -H "apikey: $SERVICE_KEY" \
  -H "Authorization: Bearer $SERVICE_KEY"
# Expected: a JSON array with one row — proves service_role bypasses RLS.
```

Then `unset SERVICE_KEY` and clear the value from your shell history.

---

## Test 5 — Flask backend still works (the BYPASSRLS proof)

The Flask backend connects with the `postgres` role (BYPASSRLS).
After the migration, hit any authenticated endpoint and confirm you
still see your real data. See `04_test_flask_smoke.md` for the
end-to-end smoke test plan.

If Flask returns empty results where it shouldn't, the connection role
is NOT bypassing RLS. Check immediately:

```sql
-- Run in Supabase SQL Editor as postgres
SELECT current_user, rolbypassrls
FROM pg_roles
WHERE rolname = (SELECT current_user);
```

If `rolbypassrls` is false for whatever role Flask connects as, run
`02_rollback_disable_rls.sql` immediately, then sort out the role issue
before re-enabling RLS.
