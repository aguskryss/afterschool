# Paso 3 — Deployment plan (production, no staging)

## TL;DR

- **Total downtime risk:** zero (migration is metadata-only, no data movement, no locks held longer than ms).
- **Total wall-clock for the operator:** ~40 minutes including verification.
- **Recommended window:** Saturday 7:00–8:00 AM ET (Miami time).
- **Backout time:** ~10 seconds to paste + run `02_rollback_disable_rls.sql`.
- **Blast radius if it fails:** Flask backend returns empty results / 401s. App becomes effectively read-empty until rollback runs. No data loss possible — the migration only changes permissions and policies, never touches rows.

The rolbypassrls=true confirmation you ran means the Flask backend is provably unaffected. The remaining risk is operational (human error, typo in SQL Editor, network blip), not algorithmic.

---

## Recommended timing for a JCC after-school program

Pickup traffic is 2–6 PM ET on weekdays. Avoid that hard. Beyond pickup, parent traffic spikes when parents wake up (mark absences for the day) and after school dismissal.

Three viable windows, ranked best to worst:

### Primary: Saturday 7:00–8:00 AM ET ⭐
- After-school program is closed (no school, no pickup window).
- JCC Shabbat services don't use the parent app.
- Parents mostly asleep or at synagogue. Low background traffic.
- Lots of daylight hours afterward to monitor and respond if anything is off.
- A weekday morning support window if the change misbehaves.

### Backup: Friday 11:00 PM ET → Saturday 1:00 AM ET
- After Friday pickup window (last pickups ~6 PM, plus a buffer).
- Minimal traffic — most parents asleep or settled in for Shabbat.
- Downside: if you discover an issue at 1 AM you may not catch it before parents wake up at 6–7 AM Saturday and try to mark absences.

### Acceptable: Sunday 6:00–7:00 AM ET
- Quiet before Sunday morning JCC programs start.
- Same logic as Saturday but less buffer if Sunday school programs use the app.

### Avoid
- Any weekday between 6 AM and 9 PM ET.
- Especially 2–6 PM ET (pickup window) — a failed migration during pickup is the worst case for both child safety perception and parent trust.

---

## Pre-deployment (24 hours before)

Done once, no time pressure.

- [ ] **Backup confirmed.** Supabase → Project Settings → Backups. Confirm a backup from the last 24h exists. If not, trigger an on-demand backup (Supabase Pro tier has manual backups; Free tier auto-snapshots daily — verify the last snapshot timestamp).
- [ ] **Role permissions re-verified** (you did this; logging it for the record):
  ```sql
  SELECT rolname, rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'postgres';
  ```
  Expected: `postgres | t | f` (which is what you got).
- [ ] **Render rollback is reachable.** Open Render dashboard → service `kikar-afterschool` → Events tab. Confirm you can see prior deploys. (You won't be rolling back Render code — only DB — but having the dashboard open is part of the war room.)
- [ ] **Test accounts known to work.** Log in with each (parent, counselor, admin) ahead of time and confirm they pass 2FA / aren't locked out. Save credentials in a password manager, not in the deployment notes.
- [ ] **Communication channel decided.** If something breaks, who tells parents? Pre-draft the message (template at the bottom).

## Pre-deployment (1 hour before)

- [ ] Open these tabs in this order, all logged in:
  1. Supabase SQL Editor (with `01_enable_rls_deny_all.sql` pasted but NOT run)
  2. Supabase SQL Editor in a second tab (with `02_rollback_disable_rls.sql` pasted but NOT run)
  3. Render dashboard → service → Logs (live tail)
  4. Production app login page in a private/incognito browser
  5. A terminal with `BASE`, `SUPA_URL`, `ANON_KEY` exported (per `03_test_postgrest_locked.md` and `04_test_flask_smoke.md`)
- [ ] Run **Test 1** from `03_test_postgrest_locked.md` (the "before" state). Save the output. This proves the vulnerability exists and gives you a comparison reference.
- [ ] Run **Critical paths 1, 3, 9** from `04_test_flask_smoke.md` (login, parent children, VAPID). Save outputs. This is the "before" baseline for the Flask backend — the post-migration outputs must match.

## T-0 — Deployment window

Total operator time: **~25 minutes** if all green.

| Time | Step | Action |
|---|---|---|
| T+0:00 | 1 | In Supabase SQL Editor tab 1, click **Run** on `01_enable_rls_deny_all.sql`. |
| T+0:30 | 2 | Verify the two sanity-check queries at the bottom returned the expected output: 20 rows with `rls_enabled = true`, and `bypasses_rls = true` for the connection role. |
| T+1:00 | 3 | Verify policies exist (paste in SQL Editor): `SELECT tablename, policyname, cmd, permissive FROM pg_policies WHERE schemaname='public' AND policyname='deny_all_anon' ORDER BY tablename;` — must return 20 rows, all `cmd='ALL'`, all `permissive='RESTRICTIVE'`. |
| T+2:00 | 4 | Run **Test 2** from `03_test_postgrest_locked.md` (anon read on every sensitive table). Every line must be `[]` or `42501`. **No JSON object with real data may appear.** |
| T+5:00 | 5 | Run **Test 3** from `03_test_postgrest_locked.md` (anon writes blocked). |
| T+7:00 | 6 | Run **Test 4** from `03_test_postgrest_locked.md` (service_role still works) — one query, then unset the key. |
| T+8:00 | 7 | Run **Critical path 1** (logins for all 3 roles) from `04_test_flask_smoke.md`. All three must succeed. |
| T+10:00 | 8 | Run **Critical paths 2, 3, 9** (wrong-pw 401, parent children, VAPID). Compare outputs against the pre-migration baseline you saved earlier — they must match exactly. |
| T+15:00 | 9 | Run **Critical paths 4, 5, 7, 8** (parent absence write, counselor roster, forgot-password write, admin stats). |
| T+22:00 | 10 | Run **Critical path 6** (pickup notification end-to-end with parent → counselor SSE). This is the most operationally complex path — leave for last. |
| T+25:00 | 11 | Acceptance checklist from `04_test_flask_smoke.md` — all 9 boxes ticked. |

**If any step from T+0:30 onward fails → jump to "Rollback procedure" below.**

## Post-deployment monitoring (next 60 minutes)

Stay at the keyboard. Don't merge other PRs, don't deploy other changes, don't go for coffee.

- **Render logs (live tail):** watch for any spike in 4xx/5xx, especially 401/403/500 from `/api/parent/...`, `/api/counselor/...`, `/api/admin/...`. A baseline rate of 401s is normal (expired JWTs); look for a sudden cluster.
- **Supabase Logs:** Project → Logs → Postgres logs. Watch for any `permission denied` errors at the DB level, which would indicate RLS leaked through to the postgres role somewhere.
- **Manual sanity check at T+30 min:** open the parent app in a private window, log in as the parent test account, confirm you see children. Then log out.
- **Manual sanity check at T+60 min:** repeat. If still green, the migration is stable.
- **Re-check Supabase Security Advisor at T+30 min:** Project → Advisors → Security. The 23 errors should now be gone. If any remain, screenshot and treat as follow-up (likely sensitive_columns_exposed warnings unrelated to RLS).

If everything is green at T+60 min, post-deployment is over. The Security Advisor errors are resolved and the app is unaffected.

## Re-check 24 hours after

- [ ] Has anyone reported "the app shows nothing"? If not, the change held through one full pickup cycle.
- [ ] Render error rate vs. the prior week — same or lower (expected).
- [ ] Re-run `Test 2` once more. Result must still be `[]` / `42501` everywhere.

---

## Rollback procedure

### When to roll back (decision tree)

Run rollback **immediately** if any of:

1. Step 2 sanity check shows `bypasses_rls = false` for the connection role. (Means your DATABASE_URL is using a different role than expected — abort before testing further.)
2. Any Flask smoke test from steps 7–10 returns empty data where it shouldn't, OR returns 500 errors that didn't exist before.
3. A real user reports they can't log in, can't see their kids, or can't mark absence — and the issue reproduces with a test account.
4. Render error rate jumps >5x baseline within the first 30 minutes.

Do NOT roll back for:
- 401s on expired tokens (expected, unrelated to RLS).
- A single failed login attempt (could be wrong password, network).
- Slowness — the migration adds zero query overhead for the BYPASSRLS role.

### How to roll back (10 seconds)

1. Go to Supabase SQL Editor tab 2 (the one with `02_rollback_disable_rls.sql` already pasted).
2. Click **Run**.
3. Verify the bottom query returns 20 rows with `rls_enabled = false`.
4. Re-run Critical path 1 + 3 from `04_test_flask_smoke.md`. Login + parent children should now match pre-migration baseline.
5. **Notify yourself in writing what failed** — a screenshot of the error, the curl output, the Render log line. Don't try to re-apply the migration without understanding why it failed the first time.

### After rollback — what state are you in?

You're back to the pre-migration state: RLS off on every table, anon/authenticated have grants, PostgREST is again as exposed as before. **The Security Advisor warnings come back.** The app keeps working. Diagnose the migration failure, fix the root cause, and try again on the next maintenance window — ideally next Saturday morning.

Do not leave production rolled back for more than 7 days. The vulnerability is real and ongoing.

---

## War room layout

For the operator running the migration, keep these visible simultaneously:

```
┌─────────────────────────┬────────────────────────────┐
│ Supabase SQL Editor     │ Render Logs (live tail)    │
│ Tab 1: 01_enable_*.sql  │                            │
│ Tab 2: 02_rollback_*.sql│                            │
├─────────────────────────┼────────────────────────────┤
│ Terminal                │ Production app             │
│ (curl smoke tests)      │ (private window, logged in │
│                         │  as parent test account)   │
└─────────────────────────┴────────────────────────────┘
```

Do not have other tabs open in Supabase SQL Editor — accidentally running the wrong script in the wrong tab is one of the easiest ways to cause an outage.

---

## Communication template (use only if rollback fires)

If a real user complains during the window, post in your support channel and to any parent-facing channel:

> **App brief outage — resolved.**
>
> Between [start time] and [end time] ET we performed a security upgrade
> on the J Club app. A small subset of users may have seen empty screens
> or login errors during this window. The issue has been resolved and
> normal service is restored. No data was lost. If you continue to see
> issues, please log out and log back in. Sorry for the inconvenience.

Adjust as needed. **Do not** publicly mention "RLS", "Supabase", or "vulnerability" — you don't owe attackers a roadmap. Internally, document the incident in detail.

---

## Owner checklist before pulling the trigger

You are ready to proceed when ALL of these are true:

- [ ] You picked a window from the recommended list (Saturday 7–8 AM ET preferred).
- [ ] Supabase backup from <24h exists.
- [ ] Pre-migration baseline outputs (Test 1, Critical paths 1+3+9) are saved.
- [ ] All four browser tabs and one terminal are open and live.
- [ ] You have personally logged in as parent + counselor + admin test accounts in the last hour.
- [ ] You have ~60 minutes uninterrupted ahead of you.
- [ ] You are not also deploying Render code or making any other infra change in this window.

If any box is unchecked, postpone to the next viable window.
