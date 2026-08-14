"""Supabase Storage, kept behind three functions.

Photos are the one thing in this app that isn't a row in Postgres. Rather than
scattering bucket names and service keys through app.py, the whole dependency
lives here: if the JCC ever moves to S3 or the bucket layout changes, this file
is the blast radius.

The REST API is used directly rather than the Supabase SDK — `requests` is
already a dependency, and the three calls needed are one HTTP request each.

Configuration (Render environment):
    SUPABASE_URL            https://<project>.supabase.co
    SUPABASE_SERVICE_KEY    the service_role key, never the anon key
    SUPABASE_PHOTOS_BUCKET  defaults to 'photos'

The bucket must be **private**. Reads go through short-lived signed URLs from
signed_url() below; a public bucket would make every photo readable by anyone
who guesses a path, which for photographs of other people's children is the
whole thing this is trying to prevent.
"""

import os
import uuid

import requests

# Storage calls sit in the request path of a counselor uploading from a phone
# on JCC wifi. Long enough to survive a slow link, short enough that a hung
# Supabase doesn't pin a gunicorn thread indefinitely.
_TIMEOUT = 30

# Extensions we hand back to the browser. Anything else is rejected at upload:
# the bucket should hold photographs, not arbitrary files under a photo's name.
ALLOWED_EXTENSIONS = {'jpg', 'jpeg', 'png', 'webp', 'heic'}

_CONTENT_TYPES = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'webp': 'image/webp',
    'heic': 'image/heic',
}


class StorageError(RuntimeError):
    """Raised when Supabase refuses a call or is not configured."""


def _config():
    url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    key = os.environ.get('SUPABASE_SERVICE_KEY') or ''
    bucket = os.environ.get('SUPABASE_PHOTOS_BUCKET') or 'photos'
    if not url or not key:
        raise StorageError(
            'Photo storage is not configured. Set SUPABASE_URL and '
            'SUPABASE_SERVICE_KEY.'
        )
    return url, key, bucket


def is_configured() -> bool:
    """Whether uploads can work at all, for surfacing a clear error early."""
    try:
        _config()
        return True
    except StorageError:
        return False


def build_path(organization_id, date_str: str, filename: str) -> str:
    """Where one photo lives in the bucket.

    Prefixed by organization so a path-handling bug can't reach across JCCs:
    even a wrong object name stays inside the tenant that wrote it.
    """
    ext = (filename.rsplit('.', 1)[-1] if '.' in filename else '').lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise StorageError(f'Unsupported image type: .{ext or "unknown"}')
    return f'org-{organization_id}/{date_str}/{uuid.uuid4().hex}.{ext}'


def upload(path: str, data: bytes, filename: str) -> str:
    """Store bytes at `path`. Returns the path back for convenience."""
    url, key, bucket = _config()
    ext = path.rsplit('.', 1)[-1].lower()
    res = requests.post(
        f'{url}/storage/v1/object/{bucket}/{path}',
        data=data,
        headers={
            'Authorization': f'Bearer {key}',
            'Content-Type': _CONTENT_TYPES.get(ext, 'application/octet-stream'),
            # Paths carry a uuid, so a collision means a bug rather than a
            # retry — fail instead of quietly overwriting someone's photo.
            'x-upsert': 'false',
        },
        timeout=_TIMEOUT,
    )
    if not res.ok:
        raise StorageError(f'Upload failed ({res.status_code}): {res.text[:200]}')
    return path


def signed_url(path: str, seconds: int = 3600) -> str | None:
    """A time-limited URL for one object.

    Returns None rather than raising: one unreadable photo should leave a gap
    in the gallery, not blank the whole screen.
    """
    try:
        url, key, bucket = _config()
        res = requests.post(
            f'{url}/storage/v1/object/sign/{bucket}/{path}',
            json={'expiresIn': seconds},
            headers={'Authorization': f'Bearer {key}'},
            timeout=_TIMEOUT,
        )
        if not res.ok:
            print(f'[WARN] signed_url {path}: {res.status_code} {res.text[:120]}')
            return None
        signed = (res.json() or {}).get('signedURL') or ''
        return f'{url}/storage/v1{signed}' if signed else None
    except Exception as e:
        print(f'[WARN] signed_url {path}: {e}')
        return None


def signed_urls(paths, seconds: int = 3600) -> dict:
    """Sign a whole page of photos in one request. path -> URL (or None).

    signed_url() above costs one HTTPS round trip to Supabase per photo, and
    the callers are galleries: the parent one already asks for up to 200 rows,
    which is up to 200 sequential requests holding a gunicorn thread the whole
    time. It has not hurt yet only because there are few photos. Any view that
    is not scoped to a single day makes it the normal case.

    Supabase signs in bulk from one endpoint, so this is one call whatever the
    page size. Falls back to the per-object path if the bulk call fails, and
    returns None for anything still unsigned — one missing photo should leave a
    gap in the grid, never blank the screen.
    """
    wanted = [p for p in dict.fromkeys(paths) if p]
    if not wanted:
        return {}
    try:
        url, key, bucket = _config()
        res = requests.post(
            f'{url}/storage/v1/object/sign/{bucket}',
            json={'expiresIn': seconds, 'paths': wanted},
            headers={'Authorization': f'Bearer {key}'},
            timeout=_TIMEOUT,
        )
        if res.ok:
            out = {}
            for item in res.json() or []:
                signed = (item or {}).get('signedURL') or ''
                # Supabase reports per-object failures inside a 200, so a
                # missing signedURL here is one bad path and not a bad call.
                out[item.get('path')] = f'{url}/storage/v1{signed}' if signed else None
            return {p: out.get(p) for p in wanted}
        print(f'[WARN] bulk sign {res.status_code}: {res.text[:120]}')
    except Exception as e:
        print(f'[WARN] bulk sign: {e}')
    # One call failing should not cost the gallery; pay the round trips.
    return {p: signed_url(p, seconds) for p in wanted}


def delete(path: str) -> None:
    """Remove one object. Never raises — see the caller for why."""
    try:
        url, key, bucket = _config()
        requests.delete(
            f'{url}/storage/v1/object/{bucket}/{path}',
            headers={'Authorization': f'Bearer {key}'},
            timeout=_TIMEOUT,
        )
    except Exception as e:
        # The database row is already gone by the time this runs. A failure
        # here leaves an orphaned object, which costs storage; raising would
        # instead leave a photo the parent can still see after the counselor
        # deleted it, which costs trust.
        print(f'[WARN] photo delete {path}: {e}')
