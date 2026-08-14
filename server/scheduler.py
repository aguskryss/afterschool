"""The daily jobs a JCC configures and then stops thinking about.

Today there is one: the attendance check. A JCC sets a time, and at that time
every family whose child is expected and unconfirmed gets asked whether they
are coming. Before this it was a counselor tapping a button per child.

WHAT MAKES THIS DIFFERENT FROM A LOOP WITH A SLEEP

  IT MUST RUN ONCE, NOT ONCE PER WORKER.
      gunicorn runs N workers and Render runs two containers side by side
      during a rolling deploy. Every one of them would tick. The claim is a
      single INSERT into scheduled_runs whose primary key is
      (organization, job, date): the second writer conflicts and does nothing.
      Same trick bulk_invite_jobs uses, for the same reason.

  THE TIME IS THE JCC'S, NOT THE SERVER'S.
      1:00 PM in Reno is not 1:00 PM in Miami, and the server thinks in UTC.
      Each organization is compared against its own `timezone` column.

  IT CANNOT DRIFT INTO YESTERDAY.
      A tick that arrives late — the container was asleep, the deploy took a
      minute — still fires, as long as it is the same local day and not more
      than CATCH_UP_MINUTES past the configured time. Later than that and the
      question is not worth asking: pickup has happened.

THIS DEPENDS ON THE INSTANCE STAYING AWAKE
    The ticker is a thread, so it exists only while the container does. On
    Render's free tier — which spins down after ~15 minutes idle — a 1:00 PM
    attendance check would never fire, because 1:00 PM is precisely when nobody
    is using the app. render.yaml is on `starter` for that reason among others;
    dropping back to free silently disables everything in this file.

    The work is also reachable as POST /api/cron/run-due, guarded by
    CRON_SECRET, so an external scheduler can drive it. That is a belt on a
    paid instance and the only option on a free one. The claim makes a double
    trigger harmless either way.
"""

import os
import threading
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

try:
    from server.database import get_db, set_thread_organization, set_thread_superadmin
except ImportError:  # running from inside server/
    from database import get_db, set_thread_organization, set_thread_superadmin

TICK_SECONDS = 60

# How late a run may still be useful. A check meant for 1:00 PM that fires at
# 1:20 is still worth sending; at 3:00 the children have gone home and a push
# asking whether they are coming is noise that erodes the ones that matter.
CATCH_UP_MINUTES = 30

_thread = None
_lock = threading.Lock()


def _now_local(tzname):
    try:
        return datetime.now(ZoneInfo(tzname or 'America/New_York'))
    except Exception:
        return datetime.now(ZoneInfo('America/New_York'))


def _is_due(configured, tzname):
    """True when local time is at or just past `configured` today."""
    if not configured:
        return False
    try:
        hh, mm = (int(p) for p in configured.split(':'))
    except (ValueError, AttributeError):
        return False
    now = _now_local(tzname)
    target = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    return target <= now <= target + timedelta(minutes=CATCH_UP_MINUTES)


def _claim(organization_id, job, local_date):
    """Take the day's slot for this job, or return False if someone already has.

    One statement, so two workers racing cannot both win.
    """
    db = get_db()
    try:
        row = db.execute("""
            INSERT INTO scheduled_runs (organization_id, job, run_date)
            VALUES (%s, %s, %s)
            ON CONFLICT (organization_id, job, run_date) DO NOTHING
            RETURNING organization_id
        """, (organization_id, job, local_date)).fetchone()
        db.commit()
        return row is not None
    except Exception as e:
        # A claim that errors must not run the job. Losing a day's check is
        # recoverable; sending every parent the same question twice is the
        # thing people remember.
        print(f"[scheduler] claim failed for org {organization_id}: {e.__class__.__name__}")
        return False
    finally:
        db.close()


def _record(organization_id, job, local_date, detail):
    db = get_db()
    try:
        db.execute("""
            UPDATE scheduled_runs SET detail = %s::jsonb
             WHERE organization_id = %s AND job = %s AND run_date = %s
        """, (detail, organization_id, job, local_date))
        db.commit()
    except Exception as e:
        print(f"[scheduler] could not record run detail: {e.__class__.__name__}")
    finally:
        db.close()


def due_organizations():
    """Organizations whose attendance check is due right now, unclaimed.

    Reads across tenants deliberately — that is the question being asked — and
    narrows to one organization before any of its rows are touched.
    """
    set_thread_superadmin()
    db = get_db()
    try:
        rows = db.execute("""
            SELECT o.id, o.slug, o.name, o.timezone, s.attendance_check_at
              FROM organizations o
              JOIN notification_settings s ON s.organization_id = o.id
             WHERE s.attendance_check_at IS NOT NULL
               AND o.status = 'active'
        """).fetchall()
    finally:
        db.close()
    return [r for r in rows if _is_due(r['attendance_check_at'], r['timezone'])]


def run_due(send_check):
    """Fire every attendance check that is due. Returns a list of what ran.

    `send_check(organization_id)` is injected rather than imported: the sending
    lives in app.py, which imports this module, and reaching back would be a
    cycle. It returns how many parents were asked.
    """
    ran = []
    for org in due_organizations():
        local_date = _now_local(org['timezone']).date()
        if not _claim(org['id'], 'attendance_check', local_date):
            continue
        # Narrow before touching the organization's own rows. Left wide open,
        # a query written here later would silently read every tenant.
        set_thread_organization(org['id'])
        try:
            asked = send_check(org['id'])
            _record(org['id'], 'attendance_check', local_date,
                    '{"asked": %d}' % int(asked or 0))
            ran.append({'organization_id': org['id'], 'slug': org['slug'],
                        'asked': asked})
            print(f"[scheduler] attendance check for {org['slug']}: asked {asked}")
        except Exception as e:
            print(f"[scheduler] attendance check failed for {org['slug']}: "
                  f"{e.__class__.__name__}: {e}")
        finally:
            set_thread_superadmin()
    return ran


def start(send_check):
    """Start the in-process ticker. Safe to call more than once.

    Not started at import: a module-level thread would also spin up inside
    every test and every management script that imports app.py.
    """
    global _thread
    with _lock:
        if _thread is not None and _thread.is_alive():
            return
        _thread = threading.Thread(
            target=_loop, args=(send_check,), daemon=True, name='kikar-scheduler')
        _thread.start()
        print('[scheduler] ticker started')


def _loop(send_check):
    set_thread_superadmin()
    while True:
        try:
            run_due(send_check)
        except Exception as e:
            # A scheduler that dies on one bad day stops working for every day
            # after it, silently. Log and keep ticking.
            print(f"[scheduler] tick failed: {e.__class__.__name__}: {e}")
            set_thread_superadmin()
        time.sleep(TICK_SECONDS)


def enabled() -> bool:
    """The ticker is opt-out so a paid instance gets it without configuration,
    and can be silenced where a external cron drives everything instead."""
    return (os.environ.get('SCHEDULER_ENABLED', '1') or '').lower() not in ('0', 'false', 'no')
