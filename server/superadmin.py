"""Kikar's platform console: the routes only a superadmin can reach.

Kept in its own module because the authorization rule here is the inverse of
everywhere else. Every other route is confined to one organization; these
deliberately reach across all of them, so the check that gates them should be
easy to find and hard to weaken by accident.
"""

import json
import os
import re
import secrets
from datetime import datetime, timedelta

import bcrypt
from flask import Blueprint, g, jsonify, request
from flask_jwt_extended import get_jwt, get_jwt_identity, jwt_required

try:
    from server.database import get_db, get_db_transaction
    from server import brand_storage, photo_storage, tenancy
except ImportError:  # running from inside server/
    from database import get_db, get_db_transaction
    import brand_storage
    import photo_storage
    import tenancy

bp = Blueprint('superadmin', __name__, url_prefix='/api/superadmin')

_SLUG = re.compile(r'^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$')
_HEX = re.compile(r'^#[0-9a-fA-F]{6}$')


def _require_superadmin():
    """None when allowed, otherwise the response to return.

    Reads the role from the token rather than from g, so a bug in the tenant
    hook can't quietly widen who gets in here.
    """
    if (get_jwt() or {}).get('role') != 'superadmin':
        return jsonify({'error': 'Unauthorized'}), 403
    # These routes are cross-organization by definition; the connection has to
    # be told so, or RLS hides every row from them.
    g.is_superadmin = True
    g.organization_id = None
    return None


def _org_row(row):
    modules = dict(tenancy.default_modules())
    modules.update(row.get('modules') or {})
    return {
        'id': row['id'],
        'slug': row['slug'],
        'name': row['name'],
        # What to render: the uploaded file if there is one, else the pasted
        # link. `logo_uploaded` lets the console tell the two apart, because
        # "Remove" means delete an object for one and clear a text field for
        # the other.
        'logo_url': tenancy.org_logo_url(row),
        'logo_uploaded': bool(row['logo_path']),
        'brand_primary': row['brand_primary'],
        'brand_accent': row['brand_accent'],
        'timezone': row['timezone'],
        'status': row['status'],
        'modules': modules,
        'email_from_local': row['email_from_local'],
        'email_from_name': row['email_from_name'],
        'email_reply_to': row['email_reply_to'],
        # What the console should show as the actual sender. Computed rather
        # than stored so the fallback to the slug is visible instead of looking
        # like "not configured" when it is in fact working.
        'email_from': tenancy.org_from_email(row['email_from_local'], row['slug']),
        'email_sender_domain': tenancy.EMAIL_SENDER_DOMAIN,
        'created_at': row['created_at'],
    }


@bp.route('/modules', methods=['GET'])
@jwt_required()
def list_modules():
    """The catalogue the console renders its toggles from."""
    denied = _require_superadmin()
    if denied:
        return denied
    return jsonify([
        {'key': key, 'label': label, 'default': default}
        for key, (label, default) in tenancy.MODULES.items()
    ])


@bp.route('/organizations', methods=['GET'])
@jwt_required()
def list_organizations():
    denied = _require_superadmin()
    if denied:
        return denied
    db = get_db()
    try:
        rows = db.execute("""
            SELECT o.*,
                   (SELECT count(*) FROM users u
                     WHERE u.organization_id = o.id AND u.role = 'parent') AS parents,
                   (SELECT count(*) FROM children c
                     WHERE c.organization_id = o.id AND c.active = 1) AS children,
                   (SELECT count(*) FROM users u
                     WHERE u.organization_id = o.id AND u.role = 'counselor') AS counselors
              FROM organizations o
             ORDER BY o.name
        """).fetchall()
    finally:
        db.close()
    out = []
    for r in rows:
        item = _org_row(r)
        item.update({
            'parents': r['parents'],
            'children': r['children'],
            'counselors': r['counselors'],
        })
        out.append(item)
    return jsonify(out)


@bp.route('/organizations', methods=['POST'])
@jwt_required()
def create_organization():
    denied = _require_superadmin()
    if denied:
        return denied
    data = request.json or {}
    name = (data.get('name') or '').strip()
    slug = (data.get('slug') or '').strip().lower()
    if not name:
        return jsonify({'error': 'Name is required'}), 400
    if not _SLUG.match(slug):
        return jsonify({
            'error': 'Slug must be 3-40 characters, lowercase letters, numbers '
                     'and hyphens, and cannot start or end with a hyphen.'
        }), 400

    db = get_db()
    try:
        if db.execute("SELECT 1 FROM organizations WHERE slug = %s", (slug,)).fetchone():
            return jsonify({'error': 'That slug is already taken'}), 409
        row = db.execute("""
            INSERT INTO organizations (slug, name, timezone, modules)
            VALUES (%s, %s, %s, %s::jsonb)
            RETURNING *
        """, (slug, name, (data.get('timezone') or 'America/New_York'), '{}')).fetchone()
        db.commit()
    finally:
        db.close()
    return jsonify(_org_row(row)), 201


@bp.route('/organizations/<int:org_id>', methods=['PATCH'])
@jwt_required()
def update_organization(org_id):
    """Branding, outgoing-mail identity, timezone and status. Slug is immutable
    on purpose — it is the stable handle everything else refers to.

    THE MAIL FIELDS ARE SUPERADMIN-ONLY AND THAT IS NOT AN ORDINARY PERMISSIONS
    CHOICE. Every other setting here affects only the organization that owns it.
    The sender does not: mail leaving this platform is signed by our verified
    domain, so an organization that could pick its own local part could take
    `noreply`, or another JCC's slug, and send mail that is — to SPF, to DKIM,
    and to the parent reading it — genuinely from us. There is no route that
    lets an organization admin write these columns, and there should not be one.
    """
    denied = _require_superadmin()
    if denied:
        return denied
    data = request.json or {}

    for field in ('brand_primary', 'brand_accent'):
        value = data.get(field)
        if value not in (None, '') and not _HEX.match(value):
            return jsonify({'error': f'{field} must be a hex colour like #2F6FED'}), 400
    if 'status' in data and data['status'] not in ('active', 'suspended'):
        return jsonify({'error': 'status must be active or suspended'}), 400

    # Normalised before validation so ' JCCNS ' becomes 'jccns' rather than
    # being rejected for a reason the person cannot see.
    if data.get('email_from_local') not in (None, ''):
        data['email_from_local'] = str(data['email_from_local']).strip().lower()
        if not tenancy.EMAIL_LOCAL_PART_RE.match(data['email_from_local']):
            return jsonify({
                'error': 'The sender must be just the part before the @ — lowercase '
                         'letters, numbers, dots, hyphens and underscores, up to 64 '
                         f'characters. The domain is always @{tenancy.EMAIL_SENDER_DOMAIN}, '
                         'because that is the domain verified with our email provider.'
            }), 400
    if data.get('email_reply_to') not in (None, ''):
        data['email_reply_to'] = str(data['email_reply_to']).strip()
        if not tenancy.EMAIL_ADDRESS_RE.match(data['email_reply_to']):
            return jsonify({'error': 'Reply-to must be an email address'}), 400
    if data.get('email_from_name') not in (None, ''):
        data['email_from_name'] = str(data['email_from_name']).strip()[:120]

    # An empty string in any of these means "clear it", not "set it to ''": the
    # send path treats NULL as "fall back" and '' would produce a nameless
    # sender or an empty Reply-To header that Resend rejects outright.
    for field in ('email_from_local', 'email_from_name', 'email_reply_to'):
        if data.get(field) == '':
            data[field] = None

    allowed = ('name', 'logo_url', 'brand_primary', 'brand_accent', 'timezone', 'status',
               'email_from_local', 'email_from_name', 'email_reply_to')
    updates = {k: data[k] for k in allowed if k in data}
    if not updates:
        return jsonify({'error': 'Nothing to update'}), 400

    sets = ', '.join(f"{k} = %s" for k in updates)
    db = get_db()
    try:
        row = db.execute(
            f"UPDATE organizations SET {sets} WHERE id = %s RETURNING *",
            (*updates.values(), org_id),
        ).fetchone()
        db.commit()
    finally:
        db.close()
    if not row:
        return jsonify({'error': 'Organization not found'}), 404
    return jsonify(_org_row(row))


@bp.route('/organizations/<int:org_id>/logo', methods=['POST'])
@jwt_required()
def upload_organization_logo(org_id):
    """Upload a JCC's logo into the `brand` bucket and point the row at it.

    The order of operations is the whole design. Upload first, then update the
    row, then delete what it used to point at:

      * If the upload fails, nothing changed and the old logo still renders.
      * If the update fails, the new object is an orphan — a few KB — and the
        old logo still renders.
      * The delete happens last and cannot fail loudly, so a JCC never ends up
        with a row pointing at an object that is already gone.

    Deleting first, or updating first, would each put a broken image in front
    of every parent at that JCC for the window in between.
    """
    denied = _require_superadmin()
    if denied:
        return denied

    if not brand_storage.is_configured():
        return jsonify({
            'error': 'Logo storage is not configured. Set SUPABASE_URL and '
                     'SUPABASE_SERVICE_KEY, and create the bucket.'
        }), 503

    upload = request.files.get('logo')
    if not upload or not upload.filename:
        return jsonify({'error': 'Attach an image as `logo`'}), 400

    db = get_db()
    try:
        row = db.execute(
            "SELECT logo_path FROM organizations WHERE id = %s", (org_id,)
        ).fetchone()
        if not row:
            return jsonify({'error': 'Organization not found'}), 404
        previous = row['logo_path']

        try:
            path = brand_storage.build_path(org_id, upload.filename)
            brand_storage.upload(path, upload.read())
            # Read it back the way a browser will, before the row starts
            # pointing at it. A private bucket accepts writes and refuses every
            # read, so skipping this saves a logo that renders as a broken
            # image with nothing on screen explaining why.
            try:
                brand_storage.verify_public(path)
            except brand_storage.StorageError:
                # Don't leave an object the row will never reference.
                brand_storage.delete(path)
                raise
        except brand_storage.StorageError as e:
            # 400 blames the file, 503 blames the deployment, and the person
            # reading it can only fix one of those. A missing bucket reported
            # as 400 reads as "your PNG is wrong", which is where the last
            # half hour went.
            return jsonify({'error': str(e)}), (503 if e.setup else 400)

        updated = db.execute(
            "UPDATE organizations SET logo_path = %s WHERE id = %s RETURNING *",
            (path, org_id),
        ).fetchone()
        db.commit()
    finally:
        db.close()

    # Last, and never fatal. See the docstring.
    if previous and previous != path:
        brand_storage.delete(previous)

    return jsonify(_org_row(updated))


@bp.route('/organizations/<int:org_id>/logo', methods=['DELETE'])
@jwt_required()
def delete_organization_logo(org_id):
    """Drop the uploaded logo. Falls back to logo_url, or to the wordmark.

    Only touches logo_path. A pasted logo_url is cleared through the ordinary
    PATCH, because clearing a text field and deleting a file are different
    enough that one button should not do both.
    """
    denied = _require_superadmin()
    if denied:
        return denied

    db = get_db()
    try:
        row = db.execute(
            "SELECT logo_path FROM organizations WHERE id = %s", (org_id,)
        ).fetchone()
        if not row:
            return jsonify({'error': 'Organization not found'}), 404
        previous = row['logo_path']
        updated = db.execute(
            "UPDATE organizations SET logo_path = NULL WHERE id = %s RETURNING *",
            (org_id,),
        ).fetchone()
        db.commit()
    finally:
        db.close()

    brand_storage.delete(previous)
    return jsonify(_org_row(updated))


@bp.route('/organizations/<int:org_id>/modules', methods=['PUT'])
@jwt_required()
def set_modules(org_id):
    denied = _require_superadmin()
    if denied:
        return denied
    data = request.json or {}
    incoming = data.get('modules')
    if not isinstance(incoming, dict):
        return jsonify({'error': 'modules must be an object of key -> boolean'}), 400

    unknown = [k for k in incoming if k not in tenancy.MODULES]
    if unknown:
        # Reject rather than ignore: a typo that silently does nothing is how
        # someone ends up believing a module is off when it is on.
        return jsonify({'error': f"Unknown modules: {', '.join(sorted(unknown))}"}), 400

    cleaned = {k: bool(v) for k, v in incoming.items()}
    db = get_db()
    try:
        row = db.execute("""
            UPDATE organizations
               SET modules = COALESCE(modules, '{}'::jsonb) || %s::jsonb
             WHERE id = %s
            RETURNING *
        """, (json.dumps(cleaned), org_id)).fetchone()
        db.commit()
    finally:
        db.close()
    if not row:
        return jsonify({'error': 'Organization not found'}), 404
    return jsonify(_org_row(row))


@bp.route('/organizations/<int:org_id>/admins', methods=['GET'])
@jwt_required()
def list_organization_admins(org_id):
    denied = _require_superadmin()
    if denied:
        return denied
    db = get_db()
    try:
        if not db.execute("SELECT 1 FROM organizations WHERE id = %s", (org_id,)).fetchone():
            return jsonify({'error': 'Organization not found'}), 404
        rows = db.execute(
            "SELECT id, email, name, created_at, password_set_at FROM users "
            " WHERE organization_id = %s AND role = 'admin' ORDER BY id",
            (org_id,),
        ).fetchall()
    finally:
        db.close()
    return jsonify([dict(r) for r in rows])


@bp.route('/organizations/<int:org_id>/admins', methods=['POST'])
@jwt_required()
def create_organization_admin(org_id):
    """Give a new organization its first administrator.

    Creating an organization used to leave it with no way in. Nothing else can
    fill the gap: POST /api/admin/admins takes the organization from the
    caller's own token, and require_admin() is an exact match on 'admin', so a
    superadmin cannot use the admin screens to bootstrap someone else's JCC.
    Without this route the only way to open a new organization was an INSERT by
    hand against the database.

    No password is set and none is returned. The account gets an unusable
    random hash and a one-time setup link, the same shape an invited admin
    gets — so a password never travels through this response or its logs.
    """
    denied = _require_superadmin()
    if denied:
        return denied

    data = request.json or {}
    name = (data.get('name') or '').strip()
    email = (data.get('email') or '').strip().lower()
    if not name or not email:
        return jsonify({'error': 'Name and email are required'}), 400
    if not re.match(r'^[^@\s]+@[^@\s]+\.[^@\s]+$', email):
        return jsonify({'error': 'That does not look like an email address'}), 400

    db = get_db()
    try:
        if not db.execute("SELECT 1 FROM organizations WHERE id = %s", (org_id,)).fetchone():
            return jsonify({'error': 'Organization not found'}), 404
        # Email is unique platform-wide, so this has to be checked across every
        # organization — which is why it belongs on a superadmin route.
        if db.execute("SELECT 1 FROM users WHERE lower(email) = %s", (email,)).fetchone():
            return jsonify({'error': 'That email already has an account'}), 409

        pw_hash = bcrypt.hashpw(
            secrets.token_urlsafe(32).encode(), bcrypt.gensalt(rounds=12)
        ).decode()
        # organization_id is named explicitly: a superadmin route pins the
        # connection to no organization, so the column default would be NULL
        # and users_org_role_check would reject a non-superadmin.
        user_id = db.execute(
            "INSERT INTO users (email, password_hash, role, name, organization_id) "
            "VALUES (%s, %s, 'admin', %s, %s) RETURNING id",
            (email, pw_hash, name, org_id),
        ).fetchone()['id']

        token = secrets.token_urlsafe(32)
        expires = (datetime.now() + timedelta(hours=168)).strftime('%Y-%m-%d %H:%M:%S')
        db.execute(
            "INSERT INTO password_reset_tokens (user_id, token, expires_at) "
            "VALUES (%s, %s, %s)",
            (user_id, token, expires),
        )
        db.commit()
    finally:
        db.close()

    base_url = os.environ.get('BASE_URL', 'http://localhost:5001')
    return jsonify({
        'id': user_id,
        'email': email,
        'name': name,
        'organization_id': org_id,
        # Shown once, in the console, for the superadmin to pass on. Handing it
        # back beats depending on email here: this is the very first account of
        # a JCC, often set up before its SMTP is configured.
        'setup_url': f"{base_url}/reset-password?token={token}",
        'expires_in_days': 7,
    }), 201


# What each of these counts is worth saying out loud before it goes. The list
# is deliberately not every table — it is the ones a person would grieve.
_INVENTORY = (
    ('children', "SELECT count(*) AS n FROM children WHERE organization_id = %s"),
    ('parents', "SELECT count(*) AS n FROM users "
                " WHERE organization_id = %s AND role = 'parent'"),
    ('counselors', "SELECT count(*) AS n FROM users "
                   " WHERE organization_id = %s AND role = 'counselor'"),
    ('admins', "SELECT count(*) AS n FROM users "
               " WHERE organization_id = %s AND role = 'admin'"),
    ('schools', "SELECT count(*) AS n FROM schools WHERE organization_id = %s"),
    ('attendance_records', "SELECT count(*) AS n FROM attendance_records "
                           " WHERE organization_id = %s"),
    ('pickup_releases', "SELECT count(*) AS n FROM pickup_releases "
                        " WHERE organization_id = %s"),
    ('photos', "SELECT count(*) AS n FROM photos WHERE organization_id = %s"),
)


@bp.route('/organizations/<int:org_id>/inventory', methods=['GET'])
@jwt_required()
def organization_inventory(org_id):
    """What deleting this organization would take with it.

    Read by the confirmation screen. The numbers come from the same query list
    the deletion itself records, so what a person is shown before they type the
    name is what actually goes.
    """
    denied = _require_superadmin()
    if denied:
        return denied
    db = get_db()
    try:
        if not db.execute("SELECT 1 FROM organizations WHERE id = %s", (org_id,)).fetchone():
            return jsonify({'error': 'Organization not found'}), 404
        return jsonify({label: db.execute(sql, (org_id,)).fetchone()['n']
                        for label, sql in _INVENTORY})
    finally:
        db.close()


@bp.route('/organizations/<int:org_id>', methods=['DELETE'])
@jwt_required()
def delete_organization(org_id):
    """Delete an organization and everything inside it. There is no undo.

    Every one of the forty tables that carries `organization_id` references
    organizations ON DELETE CASCADE, so a single DELETE empties all of them and
    leaves nothing orphaned. That is the easy part, and it is why this route is
    short. The parts worth reading are the three that the cascade cannot do.

    THE NAME HAS TO BE TYPED
        An id in a URL is one keystroke away from a different JCC. Requiring
        the organization's own name, matched exactly, means the request carries
        proof that the caller knew which one they were looking at.

    THE PHOTOGRAPHS ARE NOT IN POSTGRES
        They are objects in Supabase Storage; `photos` only holds their paths.
        The cascade removes the rows and leaves the objects, so the paths are
        copied into organization_deletions *before* the delete and the objects
        are removed *after* it. That order is on purpose: doing storage first
        would risk destroying an organization's photographs and then failing to
        delete the organization, which is the one outcome with no way back.
        photo_storage.delete never raises, so a storage failure cannot strand a
        half-finished deletion — and the recorded paths mean anything it misses
        is still findable.

    SOMETHING HAS TO SURVIVE
        organization_deletions is outside the tenant schema and has no foreign
        key here, so it is the only trace left that the JCC ever existed: who
        removed it, when, and how much was in it.
    """
    denied = _require_superadmin()
    if denied:
        return denied

    # One transaction for the reads and the writes both: the photo paths
    # recorded have to be the photo paths deleted, with no window in between
    # for an upload to slip through and leave an object nothing points at.
    # Every refusal below rolls back before returning — nothing has been
    # written yet, so it costs nothing and it ends the transaction where it is
    # read rather than leaving that to the pool.
    db = get_db_transaction()
    try:
        org = db.execute(
            "SELECT id, slug, name FROM organizations WHERE id = %s", (org_id,)
        ).fetchone()
        if not org:
            db.rollback()
            return jsonify({'error': 'Organization not found'}), 404

        if ((request.json or {}).get('confirm') or '').strip() != org['name']:
            db.rollback()
            return jsonify({
                'error': f"To delete this organization, type its name exactly: "
                         f"{org['name']}"
            }), 400

        # Deleting an organization deletes its users, so a caller who belongs to
        # this one is asking to delete their own account and the way back in.
        #
        # users_org_role_check already guarantees a superadmin has no
        # organization, so this cannot fire for a current one. It fires for a
        # *stale* token: authorization above reads the role out of the JWT, and
        # a token minted before someone was demoted still says superadmin until
        # it expires. Cheap to check, and the thing it prevents is unrecoverable.
        actor_id, actor_email = None, None
        try:
            actor_id = int(get_jwt_identity())
        except (TypeError, ValueError):
            actor_id = None
        if actor_id is not None:
            me = db.execute(
                "SELECT email, organization_id FROM users WHERE id = %s", (actor_id,)
            ).fetchone()
            if me:
                actor_email = me['email']
                if me['organization_id'] == org_id:
                    db.rollback()
                    return jsonify({
                        'error': 'This is your own organization. Deleting it would '
                                 'delete your account with it.'
                    }), 409

        counts = {label: db.execute(sql, (org_id,)).fetchone()['n']
                  for label, sql in _INVENTORY}
        paths = [row['storage_path'] for row in db.execute(
            "SELECT storage_path FROM photos WHERE organization_id = %s", (org_id,)
        ).fetchall()]

        db.execute("""
            INSERT INTO organization_deletions
                (deleted_organization_id, slug, name, deleted_by, deleted_by_email,
                 counts, photo_paths)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb)
        """, (org_id, org['slug'], org['name'], actor_id, actor_email,
              json.dumps(counts), json.dumps(paths)))
        db.execute("DELETE FROM organizations WHERE id = %s", (org_id,))
        db.commit()
    except Exception as e:
        db.rollback()
        # An organization's name is not a secret, but the exception text can
        # carry row contents; log the type and return neither.
        print(f"[ERROR] organization delete failed: {type(e).__name__}")
        return jsonify({'error': 'The organization was not deleted.'}), 500
    finally:
        db.close()

    # After the commit, never before. See the docstring.
    for path in paths:
        photo_storage.delete(path)

    return jsonify({
        'message': f"{org['name']} was deleted",
        'deleted': counts,
        # Attempted rather than removed: photo_storage.delete swallows its
        # failures by design, so claiming they are gone would be a guess.
        'photo_objects_attempted': len(paths),
    })


@bp.route('/deletions', methods=['GET'])
@jwt_required()
def list_deletions():
    """The record of organizations that were removed, newest first."""
    denied = _require_superadmin()
    if denied:
        return denied
    db = get_db()
    try:
        rows = db.execute("""
            SELECT id, deleted_organization_id, slug, name, deleted_by_email,
                   deleted_at, counts,
                   jsonb_array_length(photo_paths) AS photo_objects
              FROM organization_deletions
             ORDER BY deleted_at DESC
             LIMIT 50
        """).fetchall()
    finally:
        db.close()
    return jsonify([dict(r) for r in rows])
