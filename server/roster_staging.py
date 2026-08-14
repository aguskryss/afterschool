"""Stage a parsed roster, show it for review, then apply it.

`roster_import.py` reads the spreadsheet and touches nothing. This module is
the half that talks to the database: it writes the parse into
`roster_import_batches` / `roster_import_rows`, decides what each row would do
to the live tables, and — only when an admin says so — applies it.

WHY IT IS STAGED
    The numbers on the review screen and the rows that commit come from the
    same parse, read back out of `roster_import_rows`. Parsing the upload a
    second time at commit would let a preview say 157 and a commit write 156
    with nobody able to tell.

WHY IT CREATES PARENT ACCOUNTS BUT SENDS NOTHING
    `children.parent_id` is NOT NULL, so a child cannot exist without a user
    to hang it on. The roster's Contact #1 is that user — 126 distinct emails
    across the JCC's 157 children, 31 of them siblings sharing a parent.

    Those accounts are created with an unusable random password and **no email
    is sent**. Inviting 126 families is a decision someone makes on purpose,
    with the bulk invitation job, not a side effect of clicking Import. The
    accounts sit inert until then, exactly like an admin added by hand.

WHY A ROW CAN BE BLOCKED
    Three NOT NULLs stand between a parsed row and a `children` row: a name, a
    school, and a parent. A row missing any of them is marked `blocked`,
    reported on the review screen with its spreadsheet row number, and skipped
    at commit. The other rows still go in — holding 156 children hostage to
    one unreadable cell helps nobody.

TENANCY
    Every statement here runs on the caller's connection, which the request
    already pinned to one organization. `organization_id` comes from the column
    default, so none of these INSERTs name it — see tenancy._ensure_columns.
"""

import json
import re
import secrets
from datetime import datetime

import bcrypt

try:
    from server import roster_import
except ImportError:  # running from inside server/
    import roster_import

# Preview batches hold a second copy of children's dates of birth, allergies
# and phone numbers with a different lifetime from `children`. Pruning them is
# a privacy control, not housekeeping — see sql/29's banner.
PREVIEW_RETENTION_DAYS = 7

WEEKDAYS = roster_import.WEEKDAYS


# ─────────────────────────────────────────────────────────────────────────────
# Schools
# ─────────────────────────────────────────────────────────────────────────────

def _norm(value) -> str | None:
    return roster_import.normalize_school_token(value)


def is_placeholder(token) -> bool:
    """True for a School cell that names no school — `????` and friends.

    The distinction decides whether the importer may create the school itself.
    A cell with letters in it is a name; a cell of punctuation is a note to
    self that somebody still has to find out where the child goes.
    """
    return not re.search(r'[0-9a-z]', (token or '').lower())


def sync_school_aliases(db, tokens) -> dict:
    """Make sure every school token seen in a file has an alias row.

    `tokens` is {normalised form: the spelling the file used}.

    A named school that this organization does not have yet is **created**.
    The alternative — leaving it unresolved — means a JCC's first upload
    blocks on every one of its schools and Heather has to type five of them by
    hand before anything imports, which is exactly the retyping this feature
    exists to stop. The file already tells us the name; the only thing it does
    not tell us is which of *ours* it is, and for a new organization there is
    no ambiguity to resolve.

    A placeholder is the case that genuinely needs a person: there is no name
    to create a school from. It gets an alias row with a NULL `school_id`,
    which is what "seen, still to be resolved" looks like, so the answer can be
    given once instead of on every upload.
    """
    existing = {
        row['alias_norm']: row
        for row in db.execute("SELECT id, alias_norm, school_id FROM school_aliases").fetchall()
    }

    schools = {}
    for row in db.execute("SELECT id, name FROM schools").fetchall():
        key = _norm(row['name'])
        if key:
            schools.setdefault(key, row['id'])

    for token, display in sorted(tokens.items()):
        if not token or token in existing:
            continue
        school_id = schools.get(token)
        if school_id is None and not is_placeholder(token):
            school_id = db.execute(
                "INSERT INTO schools (name) VALUES (%s) RETURNING id", (display or token,)
            ).fetchone()['id']
            schools[token] = school_id
        db.execute(
            "INSERT INTO school_aliases (alias, alias_norm, school_id, source) "
            "VALUES (%s, %s, %s, 'import')",
            (display or token, token, school_id),
        )

    return school_map(db)


def school_map(db) -> dict:
    """alias_norm -> school_id (or None when it still needs a human)."""
    return {
        row['alias_norm']: row['school_id']
        for row in db.execute("SELECT alias_norm, school_id FROM school_aliases").fetchall()
    }


def list_school_aliases(db) -> list:
    rows = db.execute("""
        SELECT a.id, a.alias, a.alias_norm, a.school_id, a.source, s.name AS school_name
          FROM school_aliases a
          LEFT JOIN schools s ON s.id = a.school_id
         ORDER BY (a.school_id IS NOT NULL), lower(a.alias)
    """).fetchall()
    return [dict(r) for r in rows]


def resolve_school_alias(db, alias_norm, school_id=None, school_name=None):
    """Point an alias at a school, creating the school if only a name is given.

    Returns (alias_row, error). The alias must already exist: they are created
    by an upload, and inventing one here would let a typo become a school.
    """
    alias = db.execute(
        "SELECT * FROM school_aliases WHERE alias_norm = %s", (alias_norm,)
    ).fetchone()
    if not alias:
        return None, 'Unknown school alias'

    if school_id is None:
        name = (school_name or '').strip()
        if not name:
            return None, 'A school id or name is required'
        found = db.execute(
            "SELECT id FROM schools WHERE lower(name) = lower(%s)", (name,)
        ).fetchone()
        if found:
            school_id = found['id']
        else:
            school_id = db.execute(
                "INSERT INTO schools (name) VALUES (%s) RETURNING id", (name,)
            ).fetchone()['id']
    elif not db.execute("SELECT 1 FROM schools WHERE id = %s", (school_id,)).fetchone():
        return None, 'Unknown school'

    db.execute(
        "UPDATE school_aliases SET school_id = %s, source = 'manual' WHERE id = %s",
        (school_id, alias['id']),
    )
    return dict(db.execute(
        "SELECT * FROM school_aliases WHERE id = %s", (alias['id'],)
    ).fetchone()), None


# ─────────────────────────────────────────────────────────────────────────────
# Matching against the children already in the organization
# ─────────────────────────────────────────────────────────────────────────────

def _match_keys(last, first, name):
    """The keys a child can be recognised by, most specific first."""
    keys = []
    if last and first:
        keys.append(('n', last.strip().casefold(), first.strip().casefold()))
    if name:
        keys.append(('d', re.sub(r'\s+', ' ', name).strip().casefold()))
    return keys


def _existing_children(db) -> dict:
    """Every child in this organization, indexed by each key it answers to."""
    index = {}
    rows = db.execute("""
        SELECT id, name, first_name, last_name, grade_label, grade_num, dob, sex,
               allergies, bus_rider, notes, arrival_mode, roster_flag,
               school_id, parent_id, active
          FROM children
    """).fetchall()
    for row in rows:
        for key in _match_keys(row['last_name'], row['first_name'], row['name']):
            index.setdefault(key, dict(row))
    return index


# Fields the importer owns. Anything not listed here — service_type,
# release_group, parent_id — is left alone on an update: the roster does not
# describe them, so it must not overwrite them.
_CHILD_FIELDS = (
    'name', 'first_name', 'last_name', 'grade_label', 'grade_num', 'dob', 'sex',
    'allergies', 'bus_rider', 'notes', 'arrival_mode', 'roster_flag', 'school_id',
)


def _child_values(child, school_id) -> dict:
    return {
        'name': child.name,
        'first_name': child.first_name,
        'last_name': child.last_name,
        'grade_label': child.grade_label,
        'grade_num': child.grade_num,
        'dob': child.dob,
        'sex': child.sex,
        'allergies': child.allergies,
        'bus_rider': child.bus_rider,
        'notes': child.notes,
        'arrival_mode': child.arrival_mode,
        'roster_flag': child.roster_flag,
        'school_id': school_id,
    }


def _diff(existing, incoming) -> list:
    """What an update would change, for the review screen.

    A blank in the spreadsheet never clears a value that is already there: the
    roster is edited by hand and a cell someone did not fill in is far more
    often an omission than a deletion.
    """
    changes = []
    for field in _CHILD_FIELDS:
        new = incoming.get(field)
        if new is None:
            continue
        old = existing.get(field)
        if isinstance(old, datetime):
            old = old.date()
        if old != new:
            changes.append({
                'field': field,
                'from': old.isoformat() if hasattr(old, 'isoformat') else old,
                'to': new.isoformat() if hasattr(new, 'isoformat') else new,
            })
    return changes


# ─────────────────────────────────────────────────────────────────────────────
# Staging
# ─────────────────────────────────────────────────────────────────────────────

def _contact_email(child):
    for contact in child.contacts:
        if contact.priority == 1 and (contact.email or '').strip():
            return contact.email.strip().lower()
    return None


def stage(db, filename, stream, uploaded_by=None) -> dict:
    """Parse an upload and write it to the staging tables. Returns the preview.

    Nothing in `children` is touched here. The caller commits the transaction.
    """
    parse = roster_import.parse_workbook(stream)

    # Normalised form -> the spelling the file used, which is what a school
    # created from it should be named.
    tokens = {c.school_norm: (c.school_token or c.school_raw)
              for c in parse.children if c.school_norm}
    aliases = sync_school_aliases(db, tokens)
    index = _existing_children(db)

    batch_id = db.execute(
        "INSERT INTO roster_import_batches (filename, uploaded_by, status, totals) "
        "VALUES (%s, %s, 'preview', %s::jsonb) RETURNING id",
        (filename, uploaded_by, json.dumps(parse.totals)),
    ).fetchone()['id']

    counts = {a: 0 for a in ('create', 'update', 'unchanged', 'withdraw', 'skip', 'blocked')}
    unresolved = set()

    for child in parse.children:
        notices = [n.as_dict() for n in child.notices]
        school_id = aliases.get(child.school_norm)
        email = _contact_email(child)

        # The three NOT NULLs. Each is reported as its own blocking reason so
        # the screen can say which one, not just "blocked".
        if not child.name:
            notices.append(_blocker('child_name_missing',
                                    'No child name, so there is nothing to create.',
                                    child))
        if school_id is None:
            unresolved.add(child.school_norm or '')
            notices.append(_blocker(
                'school_unresolved',
                f"The school {child.school_raw!r} is not mapped to one of yours yet.",
                child))
        if not email:
            notices.append(_blocker(
                'contact_email_missing',
                'Contact #1 has no email, and a child needs a parent account.',
                child))

        blocked = any(n['level'] == roster_import.ERROR for n in notices)

        match = None
        for key in _match_keys(child.last_name, child.first_name, child.name):
            match = index.get(key)
            if match:
                break

        values = _child_values(child, school_id)
        changes = _diff(match, values) if match else []

        if blocked:
            action = 'blocked'
        elif child.status == 'withdrawn':
            action = 'withdraw' if match else 'skip'
        elif match:
            action = 'update' if changes else 'unchanged'
        else:
            action = 'create'
        counts[action] += 1

        db.execute("""
            INSERT INTO roster_import_rows
                (batch_id, source_sheet, source_row, action, match_child_id,
                 child_name, school_raw, grade_raw, parsed, changes, notices)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s::jsonb)
        """, (
            batch_id, child.source_sheet, child.source_rows[0], action,
            match['id'] if match else None,
            child.name, child.school_raw, child.grade_label,
            json.dumps(child.as_dict()), json.dumps(changes), json.dumps(notices),
        ))

    totals = dict(parse.totals)
    totals['actions'] = counts
    totals['unresolved_schools'] = sorted(t for t in unresolved if t)
    db.execute(
        "UPDATE roster_import_batches SET totals = %s::jsonb WHERE id = %s",
        (json.dumps(totals), batch_id),
    )

    _prune(db, keep_batch_id=batch_id)
    return preview(db, batch_id)


def _blocker(code, message, child) -> dict:
    return roster_import.Notice(
        code, message, roster_import.ERROR,
        sheet=child.source_sheet,
        row=child.source_rows[0] if child.source_rows else None,
    ).as_dict()


def _prune(db, keep_batch_id=None) -> None:
    """Drop previews nobody acted on. See PREVIEW_RETENTION_DAYS."""
    db.execute(
        "DELETE FROM roster_import_batches "
        " WHERE status = 'preview' AND id <> %s "
        f"   AND uploaded_at < NOW() - INTERVAL '{PREVIEW_RETENTION_DAYS} days'",
        (keep_batch_id or -1,),
    )


# ─────────────────────────────────────────────────────────────────────────────
# Reading a batch back
# ─────────────────────────────────────────────────────────────────────────────

def list_batches(db, limit=20) -> list:
    rows = db.execute("""
        SELECT b.id, b.filename, b.status, b.uploaded_at, b.committed_at, b.totals,
               u.name AS uploaded_by_name
          FROM roster_import_batches b
          LEFT JOIN users u ON u.id = b.uploaded_by
         ORDER BY b.uploaded_at DESC
         LIMIT %s
    """, (limit,)).fetchall()
    return [dict(r) for r in rows]


def preview(db, batch_id) -> dict | None:
    batch = db.execute(
        "SELECT * FROM roster_import_batches WHERE id = %s", (batch_id,)
    ).fetchone()
    if not batch:
        return None

    rows = db.execute("""
        SELECT id, source_sheet, source_row, action, match_child_id, child_name,
               school_raw, grade_raw, parsed, changes, notices, applied_at
          FROM roster_import_rows
         WHERE batch_id = %s
         ORDER BY source_sheet, source_row
    """, (batch_id,)).fetchall()

    return {
        'id': batch['id'],
        'filename': batch['filename'],
        'status': batch['status'],
        'uploaded_at': batch['uploaded_at'],
        'committed_at': batch['committed_at'],
        'error': batch['error'],
        'totals': batch['totals'] or {},
        'schools': list_school_aliases(db),
        'rows': [dict(r) for r in rows],
    }


def discard(db, batch_id) -> bool:
    row = db.execute(
        "UPDATE roster_import_batches SET status = 'discarded' "
        " WHERE id = %s AND status = 'preview' RETURNING id",
        (batch_id,),
    ).fetchone()
    return bool(row)


# ─────────────────────────────────────────────────────────────────────────────
# Committing
# ─────────────────────────────────────────────────────────────────────────────

def _parent_for(db, contact, cache) -> int:
    """The user row Contact #1 maps to, created inert if it does not exist."""
    email = contact['email'].strip().lower()
    if email in cache:
        return cache[email]

    found = db.execute(
        "SELECT id FROM users WHERE lower(email) = %s", (email,)
    ).fetchone()
    if found:
        cache[email] = found['id']
        return found['id']

    # An unusable password: nobody is ever told it, and the account cannot be
    # signed into until the family is invited and sets their own.
    pw_hash = bcrypt.hashpw(secrets.token_urlsafe(32).encode(), bcrypt.gensalt(rounds=12)).decode()
    new_id = db.execute(
        "INSERT INTO users (email, password_hash, role, name) "
        "VALUES (%s, %s, 'parent', %s) RETURNING id",
        (email, pw_hash, contact.get('name') or email),
    ).fetchone()['id']
    cache[email] = new_id
    return new_id


def _class_session_id(db, day_of_week, parsed_class, cache, warnings) -> int:
    """The catalog row for this class on this weekday, created if it is new.

    The roster is the only place the class names exist, so the catalog is built
    from it rather than typed in twice.

    THE HOURS
        This used to say the roster never carries them — that its M/T/W/R/F
        columns hold "Chess", not "Chess 3:00-3:45" — and so created every row
        with start_time and end_time NULL for an admin to fill in by hand.
        Heather's real workbook writes the hours into the name itself:
        `Soccer 3:15p-4p`, `HW Club 4p-5p`. roster_import.parse_class_cell now
        splits them, and they are stored.

        This matters more than saving typing. R2 routes a child by comparing
        the class end against their dismissal time, so a class with no end time
        has no computable destination and §6.3 makes the board warn. Reading
        the hours the file already states is not inventing them — and where the
        file states none, they stay NULL and the warning stands.

    IDENTITY
        (weekday, name, start time). The start time is part of it because
        `HW Club 3p-4p` and `HW Club 4p-5p` both run on Tuesday: same name,
        same day, different class, different counselor, different room.
        Matching on name and day alone would fold them into one.

        Where the file gives no hours the name is the whole identity again,
        because there is nothing to tell two sittings apart with — see the
        comment on the lookup below, which is what keeps sql/35's flow working.

    A DISAGREEMENT IS REPORTED, NOT RESOLVED
        Where the catalog already has hours and the file gives different ones,
        the catalog wins and a warning is raised. Heather correcting a time on
        the Classes screen is the likelier truth, and silently overwriting her
        correction on the next upload is how a fix stops sticking.
    """
    name = parsed_class['name']
    start = parsed_class.get('start_time')
    end = parsed_class.get('end_time')
    key = (day_of_week, name.casefold(), start)
    if key in cache:
        return cache[key]

    # Every candidate with this name on this weekday, earliest first. Matched
    # case-insensitively so that "Chess" and "CHESS" in two rows of the same
    # spreadsheet are one class, not two. NULLS FIRST so a row still waiting for
    # its hours is the one a timeless cell adopts.
    candidates = db.execute(
        "SELECT id, start_time, end_time FROM class_sessions "
        " WHERE day_of_week = %s AND lower(name) = lower(%s)"
        " ORDER BY start_time ASC NULLS FIRST, id ASC",
        (day_of_week, name),
    ).fetchall()

    def as_text(value):
        return value.strftime('%H:%M') if value is not None else None

    found = None
    if start is None:
        # The file names the class without hours, so it has nothing to tell two
        # sittings apart with and the name is the whole identity. Taking the
        # first row keeps sql/35's own flow working: the importer creates
        # "Chess" with no hours, the admin fills them in on the Classes screen,
        # and the next upload of the same file finds *that* row instead of
        # creating a second, blank "Chess" and moving every enrolment onto it.
        found = candidates[0] if candidates else None
        if len(candidates) > 1:
            warnings.append(
                f"{name} on {day_of_week} runs more than once and the file "
                f"gives no hours, so everyone in it was put in the "
                f"{as_text(found['start_time']) or 'untimed'} class."
            )
    else:
        found = next((c for c in candidates if as_text(c['start_time']) == start), None)
        if found is None:
            # No class at that hour, but one waiting for its hours: this is that
            # class, now that the file says when it runs.
            found = next((c for c in candidates if c['start_time'] is None), None)
            if found is not None:
                db.execute(
                    "UPDATE class_sessions SET start_time = %s WHERE id = %s",
                    (start, found['id']),
                )

    if found:
        cache[key] = found['id']
        if end is not None and found['end_time'] is None:
            db.execute("UPDATE class_sessions SET end_time = %s WHERE id = %s",
                       (end, found['id']))
        elif (end is not None and found['end_time'] is not None
              and as_text(found['end_time']) != end):
            warnings.append(
                f"{name} on {day_of_week} ends at {as_text(found['end_time'])} "
                f"in the app and at {end} in the file; the app's time was kept."
            )
        return found['id']

    new_id = db.execute(
        "INSERT INTO class_sessions (name, day_of_week, start_time, end_time) "
        "VALUES (%s, %s, %s, %s) RETURNING id",
        (name, day_of_week, start, end),
    ).fetchone()['id']
    cache[key] = new_id
    return new_id


def _apply_registrations(db, child_id, registrations, classes_cache, warnings) -> None:
    """Replace this child's weekdays — and the classes on them — with the file's.

    The roster is the season's enrolment record, so a weekday it no longer
    lists is a child who no longer comes that day. Deleting only the weekdays
    the file describes would leave last season's Thursday behind forever. The
    same reasoning applies to the classes: a child dropped from Monday chess is
    dropped by the file saying nothing, not by the file saying "removed".

    Until this wrote them down, `classes` was parsed and then used only as a
    boolean — "does this weekday have anything on it" — and thrown away. The
    names were the one part of the spreadsheet the importer read and did not
    keep, and every derived view in §3 needs them.

    A weekday whose class cell said `NO CLASS` still gets its registration: the
    child comes that day and waits in care for the whole block. What it does
    not get is a class, which is why the two are written separately here.
    """
    db.execute("DELETE FROM registrations WHERE child_id = %s", (child_id,))
    db.execute("DELETE FROM class_enrollments WHERE child_id = %s", (child_id,))
    for reg in registrations:
        classes = [c for c in (reg.get('classes') or []) if c and c.get('name')]
        if reg.get('dismissal_time') is None and not classes:
            continue
        db.execute(
            "INSERT INTO registrations (child_id, day_of_week, dismissal_time) "
            "VALUES (%s, %s, %s)",
            (child_id, reg['day_of_week'], reg.get('dismissal_time')),
        )
        for parsed_class in classes:
            session_id = _class_session_id(
                db, reg['day_of_week'], parsed_class, classes_cache, warnings)
            # A child listed in the same class twice across two merged rows
            # (rule R4) is one enrolment, not a unique violation.
            db.execute(
                "INSERT INTO class_enrollments (child_id, class_session_id) "
                "VALUES (%s, %s) ON CONFLICT DO NOTHING",
                (child_id, session_id),
            )


def _apply_contacts(db, child_id, contacts) -> None:
    for contact in contacts:
        db.execute("""
            INSERT INTO child_contacts (child_id, priority, name, phone, email)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (child_id, priority) DO UPDATE
               SET name = EXCLUDED.name,
                   phone = EXCLUDED.phone,
                   email = EXCLUDED.email
        """, (child_id, contact['priority'], contact.get('name'),
              contact.get('phone'), contact.get('email')))


def _apply_compliance(db, child_id, entries) -> None:
    for entry in entries:
        db.execute("""
            INSERT INTO child_compliance (child_id, item, status, recorded_on, raw_value)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (child_id, item) DO UPDATE
               SET status = EXCLUDED.status,
                   recorded_on = EXCLUDED.recorded_on,
                   raw_value = EXCLUDED.raw_value,
                   updated_at = CURRENT_TIMESTAMP
        """, (child_id, entry['item'], entry['status'],
              entry.get('recorded_on'), entry.get('raw_value')))


def commit(db, batch_id, committed_by=None) -> tuple:
    """Apply a staged batch. Returns (result, error).

    The caller owns the transaction: this makes no commit() call of its own, so
    a failure anywhere leaves `children` exactly as it was.
    """
    batch = db.execute(
        "SELECT * FROM roster_import_batches WHERE id = %s", (batch_id,)
    ).fetchone()
    if not batch:
        return None, 'Import not found'
    if batch['status'] != 'preview':
        return None, f"This import was already {batch['status']}"

    rows = db.execute(
        "SELECT * FROM roster_import_rows WHERE batch_id = %s ORDER BY source_row",
        (batch_id,),
    ).fetchall()

    aliases = school_map(db)
    parents = {}
    # (weekday, folded name, start time) -> class_sessions.id, so a 157-child
    # import asks for "Monday chess at 3:15" once rather than once per enrolled
    # child.
    classes = {}
    # Where the file's hours disagree with hours already in the catalog. Shown
    # once each on the result screen, not once per child in the class.
    class_warnings = []
    applied = {a: 0 for a in ('created', 'updated', 'unchanged', 'withdrawn', 'skipped', 'blocked')}
    parents_created_before = _parent_count(db)

    for row in rows:
        action = row['action']
        parsed = row['parsed'] or {}

        if action == 'blocked':
            applied['blocked'] += 1
            continue
        if action == 'skip':
            applied['skipped'] += 1
            continue

        if action == 'withdraw':
            db.execute(
                "UPDATE children SET active = 0, withdrawn_at = NOW(), withdrawn_reason = %s "
                " WHERE id = %s",
                (parsed.get('notes') or 'Listed on the No Longer sheet', row['match_child_id']),
            )
            applied['withdrawn'] += 1
            _mark_applied(db, row['id'])
            continue

        school_id = aliases.get(parsed.get('school_norm'))
        contacts = parsed.get('contacts') or []
        primary = next((c for c in contacts if c.get('priority') == 1 and c.get('email')), None)
        if school_id is None or not primary:
            # The batch was staged before someone resolved a school, or the
            # alias was unmapped since. Refuse rather than invent either one.
            applied['blocked'] += 1
            continue

        parent_id = _parent_for(db, primary, parents)
        values = _child_values_from_parsed(parsed, school_id)

        if action in ('update', 'unchanged') and row['match_child_id']:
            child_id = row['match_child_id']
            sets = {k: v for k, v in values.items() if v is not None}
            if sets:
                assignments = ', '.join(f"{k} = %s" for k in sets)
                db.execute(
                    f"UPDATE children SET {assignments}, active = 1 WHERE id = %s",
                    (*sets.values(), child_id),
                )
            applied['updated' if action == 'update' else 'unchanged'] += 1
        else:
            child_id = db.execute("""
                INSERT INTO children
                    (name, parent_id, school_id, first_name, last_name, grade_label,
                     grade_num, dob, sex, allergies, bus_rider, notes, arrival_mode,
                     roster_flag, active)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, 1)
                RETURNING id
            """, (
                values['name'], parent_id, school_id, values['first_name'],
                values['last_name'], values['grade_label'], values['grade_num'],
                values['dob'], values['sex'], values['allergies'], values['bus_rider'],
                values['notes'], values['arrival_mode'], values['roster_flag'],
            )).fetchone()['id']
            applied['created'] += 1

        _apply_registrations(db, child_id, parsed.get('registrations') or [],
                             classes, class_warnings)
        _apply_contacts(db, child_id, contacts)
        _apply_compliance(db, child_id, parsed.get('compliance') or [])
        _mark_applied(db, row['id'], child_id)

    applied['parent_accounts_created'] = _parent_count(db) - parents_created_before
    # The two numbers that say the activities came across. Without them the
    # result screen counts children and stays silent about the half of the file
    # this import exists to read.
    applied['classes'] = len(classes)
    applied['class_enrolments'] = db.execute("""
        SELECT count(*) AS n
          FROM class_enrollments e
         WHERE e.child_id IN (SELECT match_child_id
                                FROM roster_import_rows
                               WHERE batch_id = %s AND match_child_id IS NOT NULL
                                 AND applied_at IS NOT NULL)
    """, (batch_id,)).fetchone()['n']
    applied['class_warnings'] = sorted(set(class_warnings))
    db.execute(
        "UPDATE roster_import_batches "
        "   SET status = 'committed', committed_by = %s, committed_at = NOW(), "
        "       totals = totals || %s::jsonb "
        " WHERE id = %s",
        (committed_by, json.dumps({'applied': applied}), batch_id),
    )
    return applied, None


def _parent_count(db) -> int:
    return db.execute("SELECT count(*) AS n FROM users WHERE role = 'parent'").fetchone()['n']


def _mark_applied(db, row_id, child_id=None) -> None:
    db.execute(
        "UPDATE roster_import_rows SET applied_at = NOW(), "
        "       match_child_id = COALESCE(%s, match_child_id) WHERE id = %s",
        (child_id, row_id),
    )


def _child_values_from_parsed(parsed, school_id) -> dict:
    """The same shape _child_values builds, read back out of JSONB."""
    dob = parsed.get('dob')
    return {
        'name': parsed.get('name'),
        'first_name': parsed.get('first_name'),
        'last_name': parsed.get('last_name'),
        'grade_label': parsed.get('grade_label'),
        'grade_num': parsed.get('grade_num'),
        'dob': datetime.strptime(dob, '%Y-%m-%d').date() if dob else None,
        'sex': parsed.get('sex'),
        'allergies': parsed.get('allergies'),
        'bus_rider': parsed.get('bus_rider'),
        'notes': parsed.get('notes'),
        'arrival_mode': parsed.get('arrival_mode'),
        'roster_flag': parsed.get('roster_flag'),
        'school_id': school_id,
    }
