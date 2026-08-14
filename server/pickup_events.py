"""Real-time pickup events, fanned out through Postgres LISTEN/NOTIFY.

This used to be a pure in-process bus, which had two problems once the app
became multi-tenant and wanted more than one worker:

  * every subscriber received every event, so a parent tapping "I'm here" at
    one JCC would light up the queue at every other JCC; and
  * a publisher could only reach subscribers inside its own process, which is
    why gunicorn was pinned to `--workers 1`.

Now each organization gets its own Postgres channel. A publisher NOTIFYs on
that channel; one listener thread per process holds a dedicated connection,
receives the notification wherever it was published from, and hands it to the
SSE queues living in *this* process. Isolation is structural: a worker only
LISTENs on channels it has a subscriber for.

Known event types:
  - "snapshot"  : initial list of unclaimed pickups sent to a new subscriber
  - "created"   : a new pickup notification was inserted
  - "claimed"   : someone tapped "I've got it"
  - "unclaimed" : the claimer undid it
  - "heartbeat" : keep-alive ping (proxies often drop idle SSE connections)
"""

import json
import queue
import select
import threading
from typing import Any, Dict, Optional

import psycopg2
import psycopg2.extensions

try:
    from server.database import DATABASE_URL, get_db
except ImportError:  # running from inside server/
    from database import DATABASE_URL, get_db

_lock = threading.Lock()
# organization_id -> subscriber queues living in this process
_subscribers: "dict[int, set[queue.Queue]]" = {}

_listener_thread: Optional[threading.Thread] = None
# The listener thread is the *only* owner of the LISTEN connection. Other
# threads never touch it; they record which organizations they want and set
# this event, and the thread reconciles. An earlier version let subscribe()
# issue LISTEN directly, which raced the thread's own connect and produced a
# stream listening on one connection while the thread polled another.
_desired_orgs: "set[int]" = set()
_dirty = threading.Event()


def _channel(organization_id: int) -> str:
    """Channel name for an organization.

    Interpolated into SQL rather than parameterised because LISTEN takes an
    identifier, not a value. Coercing to int first is what makes that safe.
    """
    return f"kikar_org_{int(organization_id)}"


# ─── Subscribing ──────────────────────────────────────────────────────────

def subscribe(organization_id: int) -> queue.Queue:
    """Register a subscriber for one organization and return its event queue."""
    q: queue.Queue = queue.Queue(maxsize=256)
    with _lock:
        _subscribers.setdefault(organization_id, set()).add(q)
        _desired_orgs.add(organization_id)
    _ensure_listener()
    _dirty.set()
    return q


def unsubscribe(q: queue.Queue, organization_id: int) -> None:
    with _lock:
        peers = _subscribers.get(organization_id)
        if not peers:
            return
        peers.discard(q)
        if peers:
            return
        _subscribers.pop(organization_id, None)
        _desired_orgs.discard(organization_id)
    _dirty.set()


# ─── Publishing ───────────────────────────────────────────────────────────

def publish(event_type: str, payload: Dict[str, Any], organization_id) -> None:
    """Fan an event out to one organization's subscribers. Never raises.

    Goes through the request's pooled connection rather than a dedicated one,
    so publishing costs no extra Postgres session — the pooler's client cap is
    tight enough that a per-process notifier connection would eat into it.
    """
    if organization_id is None:
        print(f"[pickup_events] dropping {event_type!r}: no organization in scope")
        return
    body = json.dumps({'type': event_type, 'data': payload}, default=str)
    # NOTIFY payloads are capped at 8000 bytes. Pickup events are far smaller,
    # but a silent truncation would be a nasty bug, so fall back to a bare
    # signal and let the client re-snapshot instead.
    if len(body.encode()) > 7500:
        body = json.dumps({'type': 'resync', 'data': {}})
    try:
        db = get_db()
        try:
            db.execute("SELECT pg_notify(%s, %s)",
                       (_channel(organization_id), body))
        finally:
            db.close()
    except Exception as e:  # noqa: BLE001 — a failed notify must not fail the request
        print(f"[pickup_events] publish failed: {e}")


# ─── Listener ─────────────────────────────────────────────────────────────

def _ensure_listener() -> None:
    global _listener_thread
    with _lock:
        if _listener_thread is not None and _listener_thread.is_alive():
            return
        _listener_thread = threading.Thread(
            target=_listen_forever, name='pickup-events-listener', daemon=True
        )
        _listener_thread.start()


def _connect_listener():
    conn = psycopg2.connect(DATABASE_URL)
    conn.set_isolation_level(psycopg2.extensions.ISOLATION_LEVEL_AUTOCOMMIT)
    return conn


def _deliver(organization_id: int, message: Dict[str, Any]) -> None:
    with _lock:
        targets = list(_subscribers.get(organization_id, ()))
    for q in targets:
        try:
            q.put_nowait(message)
        except queue.Full:
            # Slow consumer — drop it rather than blocking everyone else. The
            # client reconnects and gets a fresh snapshot.
            with _lock:
                peers = _subscribers.get(organization_id)
                if peers:
                    peers.discard(q)


def _reconcile(conn, armed: "set[int]") -> "set[int]":
    """Bring the connection's LISTENs in line with what subscribers want."""
    with _lock:
        wanted = set(_desired_orgs)
    with conn.cursor() as cur:
        for org in wanted - armed:
            cur.execute(f"LISTEN {_channel(org)}")
        for org in armed - wanted:
            cur.execute(f"UNLISTEN {_channel(org)}")
    return wanted


def _listen_forever() -> None:
    conn = None
    armed: "set[int]" = set()
    while True:
        try:
            if conn is None:
                conn = _connect_listener()
                # A reconnect starts with nothing armed, so everything still
                # wanted gets listened to again — otherwise live streams go
                # deaf after a blip.
                armed = set()
            if _dirty.is_set():
                _dirty.clear()
                armed = _reconcile(conn, armed)

            # 1s so a newly subscribed channel is armed promptly and a dead
            # connection is noticed while idle.
            if select.select([conn], [], [], 1) == ([], [], []):
                continue

            conn.poll()
            while conn.notifies:
                note = conn.notifies.pop(0)
                try:
                    org = int(note.channel.rsplit('_', 1)[1])
                    _deliver(org, json.loads(note.payload))
                except Exception as e:  # noqa: BLE001
                    print(f"[pickup_events] bad notification on {note.channel}: {e}")
        except Exception as e:  # noqa: BLE001
            print(f"[pickup_events] listener reconnecting: {e}")
            try:
                if conn is not None:
                    conn.close()
            except Exception:
                pass
            conn = None
            armed = set()
            threading.Event().wait(2)


def format_sse(event: Dict[str, Any]) -> str:
    """Serialize an event dict into the SSE wire format."""
    return f"event: {event['type']}\ndata: {json.dumps(event['data'], default=str)}\n\n"
