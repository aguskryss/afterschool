"""Progress state for the bulk parent-invitation job.

This used to be a module-level dict guarded by a threading.Lock, which was
correct while gunicorn ran a single worker. With more than one it silently
breaks in two ways, both of them visible to real people:

  * the "a job is already running" guard only sees its own process, so two
    workers can run the job at once and every parent receives the invitation
    twice; and
  * the progress poll can land on the worker that isn't running the job, so
    the admin watches a job that says idle while it sends hundreds of emails.

The state therefore lives in the database, where every worker sees the same
answer, and the guard is an atomic UPDATE rather than an in-process lock.
It is scoped per organization: one JCC's bulk send must not block another's.
"""

import json
from datetime import datetime, timezone

try:
    from server.database import get_db
except ImportError:  # running from inside server/
    from database import get_db

IDLE = {
    'status': 'idle',
    'sent': 0,
    'failed': 0,
    'total': 0,
    'failed_emails': [],
    'started_at': None,
    'finished_at': None,
    'error': None,
}


def ensure_schema(cur) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS bulk_invite_jobs (
            -- No inline foreign key: tenancy.ensure_tenancy_schema adds the
            -- reference, the index, the column default and the RLS policy,
            -- exactly as it does for every other tenant-scoped table.
            organization_id INTEGER PRIMARY KEY,
            status TEXT NOT NULL DEFAULT 'idle'
                CHECK (status IN ('idle', 'running', 'done')),
            sent INTEGER NOT NULL DEFAULT 0,
            failed INTEGER NOT NULL DEFAULT 0,
            total INTEGER NOT NULL DEFAULT 0,
            failed_emails JSONB NOT NULL DEFAULT '[]'::jsonb,
            started_at TIMESTAMPTZ,
            finished_at TIMESTAMPTZ,
            error TEXT
        )
    """)


def read(organization_id) -> dict:
    if organization_id is None:
        return dict(IDLE)
    db = get_db()
    try:
        row = db.execute(
            "SELECT * FROM bulk_invite_jobs WHERE organization_id = %s",
            (organization_id,),
        ).fetchone()
    finally:
        db.close()
    if not row:
        return dict(IDLE)
    return {
        'status': row['status'],
        'sent': row['sent'],
        'failed': row['failed'],
        'total': row['total'],
        'failed_emails': row['failed_emails'] or [],
        'started_at': row['started_at'].isoformat() if row['started_at'] else None,
        'finished_at': row['finished_at'].isoformat() if row['finished_at'] else None,
        'error': row['error'],
    }


def try_start(organization_id, total: int) -> bool:
    """Claim the job for this organization. False if one is already running.

    The claim is a single statement so two workers racing here cannot both
    win — which is exactly the case that used to double every invitation.
    """
    now = datetime.now(timezone.utc)
    db = get_db()
    try:
        row = db.execute("""
            INSERT INTO bulk_invite_jobs
                (organization_id, status, sent, failed, total, failed_emails,
                 started_at, finished_at, error)
            VALUES (%s, 'running', 0, 0, %s, '[]'::jsonb, %s, NULL, NULL)
            ON CONFLICT (organization_id) DO UPDATE
               SET status = 'running', sent = 0, failed = 0, total = EXCLUDED.total,
                   failed_emails = '[]'::jsonb, started_at = EXCLUDED.started_at,
                   finished_at = NULL, error = NULL
             WHERE bulk_invite_jobs.status <> 'running'
            RETURNING organization_id
        """, (organization_id, total, now)).fetchone()
        db.commit()
    finally:
        db.close()
    return row is not None


def record_result(organization_id, email: str, ok: bool, reason=None) -> None:
    db = get_db()
    try:
        if ok:
            db.execute(
                "UPDATE bulk_invite_jobs SET sent = sent + 1 "
                "WHERE organization_id = %s", (organization_id,)
            )
        else:
            db.execute("""
                UPDATE bulk_invite_jobs
                   SET failed = failed + 1,
                       failed_emails = failed_emails || %s::jsonb
                 WHERE organization_id = %s
            """, (json.dumps([{'email': email, 'reason': reason or 'send failed'}]),
                  organization_id))
        db.commit()
    finally:
        db.close()


def finish(organization_id, error=None, failed_all=None) -> None:
    db = get_db()
    try:
        if failed_all:
            db.execute("""
                UPDATE bulk_invite_jobs
                   SET failed = %s, failed_emails = %s::jsonb
                 WHERE organization_id = %s
            """, (len(failed_all), json.dumps(failed_all), organization_id))
        db.execute("""
            UPDATE bulk_invite_jobs
               SET status = 'done', finished_at = %s, error = COALESCE(%s, error)
             WHERE organization_id = %s
        """, (datetime.now(timezone.utc), error, organization_id))
        db.commit()
    finally:
        db.close()
