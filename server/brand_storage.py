"""Supabase Storage for organization logos.

Deliberately separate from photo_storage.py, and the reason is the one line
that matters in both files: **that bucket must be private, this one must be
public.**

    photos    private   read through short-lived signed URLs
    brand     public    read by <img src> and by mail clients

Photographs of other people's children must never be readable by URL alone. A
JCC's logo has the opposite requirement — it is on their public website
already, and it has to load in two places where a signed URL cannot work:

  * every screen of the app, where re-signing an expiring URL on each page load
    would cost a round trip to show a picture that is not a secret;
  * invitation email, where the recipient has no session at all and the message
    may be opened weeks later, long after any signature expired.

Sharing one module between the two would mean one `_config()` and one bucket
name standing between a private-by-design store and a public-by-design one.
The ~40 duplicated lines of HTTP are the cheaper mistake.

Configuration (Render environment):
    SUPABASE_URL            https://<project>.supabase.co
    SUPABASE_SERVICE_KEY    the service_role key, never the anon key
    SUPABASE_BRAND_BUCKET   defaults to 'brand' — CREATE IT AS PUBLIC
"""

import os
import uuid

import requests

_TIMEOUT = 30

# A logo is a small image. The cap is not about storage cost — it is that this
# file is fetched on every screen by parents on phones, and a 6 MB PNG makes
# the app feel broken on JCC wifi.
MAX_BYTES = 2 * 1024 * 1024

# SVG is included because most logos arrive as one, and it is safe in the way
# it is used here: an <img> tag never executes script in an SVG, and the bucket
# is a different origin from the app, so even a direct navigation to the object
# cannot touch a session on ours.
#
# THIS REASONING DEPENDS ON WHO CAN UPLOAD. Today that is superadmins only —
# Kikar staff. If organization admins are ever allowed to upload their own
# logo, revisit this: an untrusted SVG becomes a script hosted on the same
# Supabase origin that serves signed photo URLs, which is a different question
# from the one answered above.
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'svg'}

_CONTENT_TYPES = {
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
}


class StorageError(RuntimeError):
    """Raised when Supabase refuses a call or is not configured.

    `setup` marks the errors that are our configuration rather than the file
    somebody picked. The two need different words and different HTTP statuses:
    "that image is too large" is for the person holding the file, "the bucket
    does not exist" is for whoever set the deployment up, and telling the first
    person the second thing is how a five-minute fix becomes a support thread.
    """

    def __init__(self, message, setup=False):
        super().__init__(message)
        self.setup = setup


def _explain(res, bucket):
    """Turn a Supabase storage error into something a person can act on.

    The raw body is JSON like {"statusCode":"404","error":"Bucket not found",
    "code":"NoSuchBucket"}, and it used to be dumped straight into the console.
    It is accurate and it is useless: it does not say which bucket, where to
    create it, or that it has to be public.
    """
    body = res.text or ''
    code = ''
    try:
        code = (res.json() or {}).get('code') or ''
    except Exception:
        pass

    if code == 'InvalidRequest' and 'not public' in body.lower():
        return StorageError(
            f'The "{bucket}" bucket exists but is private, so the logo uploads '
            f'and then will not load. In Supabase, Storage → {bucket} → Edit '
            f'bucket → tick "Public bucket". Logos are read straight from a URL '
            f'by browsers and by mail clients, neither of which can sign one.',
            setup=True,
        )
    if code == 'NoSuchBucket' or 'Bucket not found' in body:
        return StorageError(
            f'The "{bucket}" bucket does not exist in Supabase. Create it under '
            f'Storage → New bucket, name it exactly "{bucket}", and tick '
            f'"Public bucket" — logos are read straight from a URL, by the app '
            f'and by email clients, so a private bucket serves errors instead '
            f'of images.',
            setup=True,
        )
    if res.status_code in (401, 403) or code in ('InvalidJWT', 'Unauthorized'):
        return StorageError(
            'Supabase rejected the service key. SUPABASE_SERVICE_KEY must be '
            'the service_role key, not the anon key.',
            setup=True,
        )
    if code == 'Duplicate' or res.status_code == 409:
        # Keys carry a uuid, so this is a bug rather than a retry.
        return StorageError(
            'That object already exists, which should be impossible. Try again.'
        )
    if res.status_code == 413:
        return StorageError(
            'Supabase rejected the file as too large. Its own limit is below '
            f'our {MAX_BYTES // 1024} KB cap — raise it in the bucket settings.',
            setup=True,
        )
    return StorageError(
        f'Supabase refused the upload ({res.status_code}). {body[:160]}',
        setup=True,
    )


def _config():
    url = (os.environ.get('SUPABASE_URL') or '').rstrip('/')
    key = os.environ.get('SUPABASE_SERVICE_KEY') or ''
    bucket = os.environ.get('SUPABASE_BRAND_BUCKET') or 'brand'
    if not url or not key:
        raise StorageError(
            'Logo storage is not configured. Set SUPABASE_URL and '
            'SUPABASE_SERVICE_KEY.',
            setup=True,
        )
    return url, key, bucket


def is_configured() -> bool:
    """Whether uploads can work at all, so the console can say so up front
    rather than after someone has picked a file."""
    try:
        _config()
        return True
    except StorageError:
        return False


def extension_of(filename: str) -> str:
    return (filename.rsplit('.', 1)[-1] if '.' in filename else '').lower()


def build_path(organization_id, filename: str) -> str:
    """Where one organization's logo lives in the bucket.

    Prefixed by organization for the same reason photos are: a path-handling
    bug stays inside the tenant that caused it.

    The uuid is not decoration. Object storage is cached hard by browsers and
    by mail clients, so overwriting `org-3/logo.png` in place would leave the
    old logo on screen for an unknowable amount of time. A new name per upload
    means the new logo is a new URL and appears immediately; the previous
    object is deleted by the caller once the row points at the new one.
    """
    ext = extension_of(filename)
    if ext not in ALLOWED_EXTENSIONS:
        raise StorageError(
            f'Unsupported image type: .{ext or "unknown"}. '
            f'Use {", ".join(sorted(ALLOWED_EXTENSIONS))}.'
        )
    return f'org-{organization_id}/logo-{uuid.uuid4().hex}.{ext}'


def upload(path: str, data: bytes) -> str:
    """Store bytes at `path`. Returns the path back for convenience."""
    if len(data) > MAX_BYTES:
        raise StorageError(
            f'That image is {len(data) // 1024} KB. The limit is '
            f'{MAX_BYTES // 1024} KB — it loads on every screen.'
        )
    if not data:
        raise StorageError('That file is empty.')
    url, key, bucket = _config()
    ext = path.rsplit('.', 1)[-1].lower()
    res = requests.post(
        f'{url}/storage/v1/object/{bucket}/{path}',
        data=data,
        headers={
            'Authorization': f'Bearer {key}',
            'Content-Type': _CONTENT_TYPES.get(ext, 'application/octet-stream'),
            # Paths carry a uuid, so a collision is a bug rather than a retry.
            'x-upsert': 'false',
            # A logo changes rarely and its URL changes when it does, so it can
            # be cached for a long time. This is what makes a public bucket
            # cheaper than signing on every page load, not just simpler.
            'Cache-Control': 'public, max-age=31536000, immutable',
        },
        timeout=_TIMEOUT,
    )
    if not res.ok:
        raise _explain(res, bucket)
    return path


def verify_public(path: str) -> None:
    """Fetch the object back the way a browser will, and raise if that fails.

    A private bucket accepts the upload and then refuses every read, so without
    this the whole flow succeeds, the row is saved, and the only symptom is a
    broken image icon in the console with nothing anywhere saying why. That is
    what happened the first time this shipped.

    One extra request per upload, and uploads are rare and superadmin-only. It
    buys the difference between "your logo is live" and "something is wrong,
    somewhere, go and look". Checking here rather than at read time is what
    makes the answer specific: at read time all we would know is that an image
    did not load.
    """
    url = public_url(path)
    if not url:
        return
    try:
        res = requests.get(url, timeout=_TIMEOUT, stream=True)
    except Exception as e:
        raise StorageError(
            f'The logo uploaded but could not be read back: {e.__class__.__name__}.',
            setup=True,
        ) from e
    if not res.ok:
        _url, _key, bucket = _config()
        raise _explain(res, bucket)


def public_url(path: str | None) -> str | None:
    """The stable, unsigned URL for a stored logo.

    None in, None out — an organization with no uploaded logo is the normal
    case, not an error. Returns None rather than raising when storage is
    unconfigured, so a missing Supabase key costs a wordmark instead of a 500
    on every request that reads an organization.
    """
    if not path:
        return None
    try:
        url, _key, bucket = _config()
    except StorageError:
        return None
    return f'{url}/storage/v1/object/public/{bucket}/{path}'


def delete(path: str | None) -> None:
    """Remove one object. Never raises.

    Called after the row has already stopped pointing at this object, so a
    failure here leaves a few KB of orphan rather than a logo the JCC thinks
    they replaced. Raising would turn a successful change into an error.
    """
    if not path:
        return
    try:
        url, key, bucket = _config()
        requests.delete(
            f'{url}/storage/v1/object/{bucket}/{path}',
            headers={'Authorization': f'Bearer {key}'},
            timeout=_TIMEOUT,
        )
    except Exception as e:
        print(f'[WARN] logo delete {path}: {e}')
