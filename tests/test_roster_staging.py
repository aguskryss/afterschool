"""Roster staging and commit tests.

`test_roster_import.py` covers the parser, which never sees a database. This
covers the half that does: what a staged row says it will do, and what actually
lands in `children`, `registrations`, `child_contacts` and `child_compliance`
when an admin approves it.

It builds its workbook in memory with openpyxl rather than reading a file. The
header row is the JCC's, verbatim; every child in it is invented.

The properties worth protecting here, each of which has a way of going wrong
quietly:

  • a child cannot exist without a parent and a school, both NOT NULL, so an
    unresolved school has to block its row rather than reach the INSERT
  • siblings share one parent account, not one each
  • importing the same file twice is not 314 children
  • a blocked row does not take the other 156 down with it
  • nothing at all is written until commit

    ADMIN_DATABASE_URL=postgresql://you@localhost:5432/kikar \
    DATABASE_URL=postgresql://kikar_app:...@localhost:5432/kikar \
    python3 tests/test_roster_staging.py
"""

import io
import os
import sys
from contextlib import contextmanager
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import openpyxl
import psycopg2
import psycopg2.extras

from server.database import DbConnection
from server import roster_staging

# The application role, on purpose, not the owner. Half of what this file
# asserts — "another JCC sees none of these children" — is a claim about row
# level security, and RLS does not apply to a superuser. Run as one and the
# organization pin is ignored, every count includes every tenant's rows, and
# the isolation checks pass or fail for reasons that have nothing to do with
# the importer. The app role is also what the importer actually runs as.
#
# ADMIN_DATABASE_URL is the fallback for an environment that only has the one
# connection string; the checks are then weaker, and say so.
APP_URL = os.environ.get('DATABASE_URL', '')
OWNER_URL = os.environ.get('ADMIN_DATABASE_URL', APP_URL)
DB_URL = APP_URL or OWNER_URL

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected!r}, got {actual!r}")
    if not ok:
        failures.append(label)


ROSTER_HEADER = [
    '?? for parents', 'School', "Child's Name", 'Grade',
    'Mon', 'M - Class', 'Tue', 'T - Class', 'Wed', 'W - Class',
    'Thur', 'R - Class', 'Fri', 'F - Class',
    'Bus', 'Sex', 'Notes', 'DOB', 'B-Day Card', 'Allergies',
    'Regist Rcvd', 'Regist Fee Chged', 'Member? Y/N/Sent', 'Pick up (pg 2)',
    'First Aid (pg 2)', 'Medication (pg 4)', 'Photo', 'Physical', 'Imm.',
    'complete',
    'Contact #1', 'Phone #1', 'Email #1', 'Contact #2', 'Phone #2', 'Email #2',
]

WITHDRAWN_HEADER = [
    'Notes', 'School', "Child's Name", 'Grade',
    'M', 'M - Class', 'T', 'T - Class', 'W', 'W - Class', 'R', ' R - Class',
    'F', 'F - Class', 'Bus', 'Sex', 'Notes', 'DOB', 'Allergies',
    'Regist Rcvd', 'Regist Fee Chged', 'Member? Y/N/Sent', 'Pick up (pg 3)',
    'First Aid (pg 3)', 'Medication (pg 4)', 'Physical', 'Imm.', 'complete',
    'Contact #1', 'Phone #1', 'Email #1', 'Contact #2', 'Phone #2', 'Email #2',
]


def row(header, **values):
    cells = [None] * len(header)
    for key, value in values.items():
        title = key.replace('_', ' ')
        for index, name in enumerate(header):
            if _norm(name) == _norm(title):
                cells[index] = value
                break
        else:  # pragma: no cover - fixture typo
            raise AssertionError(f"no column named {title!r}")
    return cells


def _norm(text):
    from server.roster_import import normalize_header
    return normalize_header(text)


def workbook(roster_rows, withdrawn_rows=()):
    """An .xlsx in memory, shaped like the JCC's."""
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = 'J Adv Roster'
    ws.append(ROSTER_HEADER)
    for r in roster_rows:
        ws.append(r)
    sheet = wb.create_sheet('No Longer')
    sheet.append(WITHDRAWN_HEADER)
    for r in withdrawn_rows:
        sheet.append(r)
    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return buffer


# Two siblings on one email, one only child, one row whose school is a
# placeholder, and one with no contact email at all.
def base_rows():
    return [
        row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Almond, Wren'}, Grade='K',
            Mon=5, Tue=4, Bus='x', Sex='F', DOB=datetime(2019, 4, 2),
            Allergies='Tree Nut (EpiPen)',
            **{'Regist Rcvd': datetime(2026, 5, 14), 'First Aid (pg 2)': 'MISSING'},
            **{'Contact #1': 'Almond, Perry', 'Phone #1': '555-0100',
               'Email #1': 'perry@example.test',
               'Contact #2': 'Almond, Sage', 'Email #2': 'sage@example.test'}),
        row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Almond, Rook'}, Grade=2,
            Mon=5, Bus='x', Sex='M', DOB=datetime(2017, 9, 9),
            **{'Contact #1': 'Almond, Perry', 'Phone #1': '555-0100',
               'Email #1': 'perry@example.test'}),
        row(ROSTER_HEADER, School='Glover', **{"Child's Name": 'Birch, Juniper'}, Grade=3,
            Wed='5**', **{'W - Class': 'Soccer 3:15p-4p'}, Bus='NO', DOB='7/19/2017',
            **{'Contact #1': 'Birch, Wren', 'Email #1': 'birch@example.test'}),
        row(ROSTER_HEADER, School='Glover', **{"Child's Name": 'Birch, Juniper'}, Grade=3,
            Wed='5**', **{'W - Class': 'Floor Hockey 4p-4:45p'}, Thur=6),
        row(ROSTER_HEADER, School='????', **{"Child's Name": 'Cedar, Fable'}, Grade=1,
            Fri=6, DOB=datetime(2020, 1, 30),
            **{'Contact #1': 'Cedar, Rowan', 'Email #1': 'cedar@example.test'}),
        row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Dogwood, Alder'}, Grade=4,
            Mon=4, DOB=datetime(2015, 5, 5), **{'Contact #1': 'Dogwood, Hazel'}),
    ]


@contextmanager
def superadmin(cur):
    """See tests/test_tenant_isolation.py for why this is deliberately narrow."""
    cur.execute("SELECT set_config('app.organization_id','',false),"
                "       set_config('app.is_superadmin','on',false)")
    try:
        yield
    finally:
        cur.execute("SELECT set_config('app.organization_id','',false),"
                    "       set_config('app.is_superadmin','off',false)")


def pin(cur, org_id):
    cur.execute("SELECT set_config('app.organization_id',%s,false),"
                "       set_config('app.is_superadmin','off',false)",
                ('' if org_id is None else str(org_id),))


def counts(db):
    one = lambda sql: db.execute(sql).fetchone()['n']
    return {
        'children': one("SELECT count(*) AS n FROM children"),
        'parents': one("SELECT count(*) AS n FROM users WHERE role='parent'"),
        'registrations': one("SELECT count(*) AS n FROM registrations"),
        'contacts': one("SELECT count(*) AS n FROM child_contacts"),
        'compliance': one("SELECT count(*) AS n FROM child_compliance"),
    }


def main() -> int:
    if not DB_URL:
        print('DATABASE_URL (or ADMIN_DATABASE_URL) is required.')
        return 2

    conn = psycopg2.connect(DB_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = True
    cur = conn.cursor()

    cur.execute("SELECT rolsuper FROM pg_roles WHERE rolname = current_user")
    if cur.fetchone()['rolsuper']:
        print()
        print('  WARNING: connected as a superuser, which bypasses row level')
        print('  security. The organization pin will be ignored and every count')
        print('  below will include other tenants\' rows. Point DATABASE_URL at')
        print('  the application role to make these checks mean anything.')
        print()

    with superadmin(cur):
        # Start from nothing rather than from whatever a crashed run left. An
        # organization that survives carries its school aliases with it, and a
        # resolved alias would quietly turn the "still to be resolved" checks
        # below into assertions about the previous run.
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-import','t-other')")
        cur.execute("INSERT INTO organizations (slug, name) VALUES ('t-import','Import JCC') "
                    "RETURNING id")
        org = cur.fetchone()['id']
        cur.execute("INSERT INTO organizations (slug, name) VALUES ('t-other','Other JCC') "
                    "RETURNING id")
        other = cur.fetchone()['id']

    pin(cur, org)
    db = DbConnection(conn, pooled=False)

    # ── Staging writes nothing to the live tables ────────────────────────────
    before = counts(db)
    result = roster_staging.stage(db, 'roster.xlsx', workbook(base_rows()))
    check('staging leaves children untouched', counts(db)['children'], before['children'])
    check('and creates no parent accounts', counts(db)['parents'], before['parents'])

    batch_id = result['id']
    actions = result['totals']['actions']
    check('the two duplicated rows are one child',
          result['totals']['children'], 5)
    check('the unknown school blocks exactly its own row', actions['blocked'], 2)
    check('everything else is new', actions['create'], 3)

    blocked = {r['child_name']: [n['code'] for n in r['notices'] if n['level'] == 'error']
               for r in result['rows'] if r['action'] == 'blocked'}
    check('the placeholder school is named as the reason',
          blocked.get('Fable Cedar'), ['school_unresolved'])
    check('and a contact with no email blocks on the parent account',
          blocked.get('Alder Dogwood'), ['contact_email_missing'])
    check('the school to resolve is reported once',
          result['totals']['unresolved_schools'], ['????'])

    # Schools seen in the file are offered for mapping...
    check('every school in the file gets an alias row',
          sorted(a['alias_norm'] for a in result['schools']),
          ['????', 'brown', 'glover'])
    # ...and a named one is created from the file itself. This organization had
    # no schools at all a moment ago; requiring them up front would mean typing
    # in by hand the very names the roster already carries.
    check('the named schools create themselves, spelled as the file spells them',
          sorted(r['name'] for r in db.execute("SELECT name FROM schools").fetchall()),
          ['Brown', 'Glover'])
    check('and only the placeholder is left for a person to answer',
          sorted(a['alias_norm'] for a in result['schools'] if a['school_id'] is None),
          ['????'])

    # ── Commit ───────────────────────────────────────────────────────────────
    applied, error = roster_staging.commit(db, batch_id, committed_by=None)
    check('commit reports no error', error, None)
    check('three children created', applied['created'], 3)
    check('the blocked rows are skipped, not written', applied['blocked'], 2)
    check('siblings share one parent account, and the third is separate',
          applied['parent_accounts_created'], 2)

    after = counts(db)
    check('children landed', after['children'], 3)
    check('one parent per distinct email', after['parents'], 2)

    wren = db.execute("SELECT * FROM children WHERE name = 'Wren Almond'").fetchone()
    check('the name halves are stored', (wren['last_name'], wren['first_name']),
          ('Almond', 'Wren'))
    check('kindergarten is grade 0 keeping its label',
          (wren['grade_label'], wren['grade_num']), ('K', 0))
    check('the allergy is stored', wren['allergies'], 'Tree Nut (EpiPen)')
    check('the date of birth is stored', wren['dob'], date(2019, 4, 2))
    check('the bus flag became an arrival mode', wren['arrival_mode'], 'bus')
    check('and the child sits in the school the roster named',
          db.execute("SELECT s.name FROM children c JOIN schools s ON s.id = c.school_id "
                     "WHERE c.name = 'Wren Almond'").fetchone()['name'], 'Brown')
    check('children from different schools are split correctly',
          sorted((r['name'], r['n']) for r in db.execute(
              "SELECT s.name, count(*) AS n FROM children c "
              "JOIN schools s ON s.id = c.school_id GROUP BY s.name").fetchall()),
          [('Brown', 2), ('Glover', 1)])

    regs = db.execute(
        "SELECT day_of_week, dismissal_time FROM registrations WHERE child_id = %s "
        "ORDER BY day_of_week", (wren['id'],)).fetchall()
    check('only the enrolled days are registrations',
          [(r['day_of_week'], r['dismissal_time']) for r in regs],
          [('Monday', 5), ('Tuesday', 4)])

    juniper = db.execute("SELECT * FROM children WHERE name = 'Juniper Birch'").fetchone()
    jregs = db.execute(
        "SELECT day_of_week, dismissal_time FROM registrations WHERE child_id = %s "
        "ORDER BY day_of_week", (juniper['id'],)).fetchall()
    check("the duplicated child's two rows became one child with both days",
          [(r['day_of_week'], r['dismissal_time']) for r in jregs],
          [('Thursday', 6), ('Wednesday', 5)])

    # ── The class names, which the importer used to read and throw away ──────
    #
    # Juniper is the case worth having: two rows, both Wednesday, each naming a
    # different class. R4 folds them into one child, and the classes have to
    # survive that fold as two enrolments rather than the last one winning.
    jclasses = db.execute("""
        SELECT s.name, s.day_of_week, s.start_time, s.end_time
          FROM class_enrollments e JOIN class_sessions s ON s.id = e.class_session_id
         WHERE e.child_id = %s ORDER BY s.name
    """, (juniper['id'],)).fetchall()
    check('both of the merged rows contributed their class',
          [(c['name'], c['day_of_week']) for c in jclasses],
          [('Floor Hockey', 'Wednesday'), ('Soccer', 'Wednesday')])
    # This used to assert the opposite — that the hours are always NULL for an
    # admin to fill in — on the strength of sql/35's claim that the roster never
    # states them. Heather's real file writes them into the class name, and R2
    # cannot route a child to a care room without the end time.
    check('and the hours written into the class name were read with it',
          [(str(c['start_time']), str(c['end_time'])) for c in jclasses],
          [('16:00:00', '16:45:00'), ('15:15:00', '16:00:00')])

    check('a child with no class column gets no enrolment',
          db.execute("SELECT count(*) AS n FROM class_enrollments WHERE child_id = %s",
                     (wren['id'],)).fetchone()['n'], 0)
    check('the catalog holds one row per class per weekday, and no more',
          db.execute("SELECT count(*) AS n FROM class_sessions").fetchone()['n'], 2)

    contacts = db.execute(
        "SELECT priority, name, email FROM child_contacts WHERE child_id = %s "
        "ORDER BY priority", (wren['id'],)).fetchall()
    check('both contacts stored in priority order',
          [(c['priority'], c['name']) for c in contacts],
          [(1, 'Almond, Perry'), (2, 'Almond, Sage')])

    compliance = db.execute(
        "SELECT item, status, recorded_on FROM child_compliance WHERE child_id = %s "
        "ORDER BY item", (wren['id'],)).fetchall()
    check('the checklist landed with its dates and its MISSING',
          [(c['item'], c['status'], c['recorded_on']) for c in compliance],
          [('first_aid', 'missing', None), ('registration', 'done', date(2026, 5, 14))])

    check('siblings really do point at the same parent row',
          db.execute("SELECT count(DISTINCT parent_id) AS n FROM children "
                     "WHERE last_name = 'Almond'").fetchone()['n'], 1)
    check('the parent account cannot be signed into yet',
          db.execute("SELECT count(*) AS n FROM users WHERE role='parent' "
                     "AND password_set_at IS NOT NULL").fetchone()['n'], 0)

    check('a committed batch cannot be committed twice',
          roster_staging.commit(db, batch_id)[1] is not None, True)

    # ── Re-uploading the same file ───────────────────────────────────────────
    again = roster_staging.stage(db, 'roster.xlsx', workbook(base_rows()))
    check('the same file a second time changes nothing',
          again['totals']['actions']['unchanged'], 3)
    check('and creates no duplicates', again['totals']['actions']['create'], 0)
    roster_staging.commit(db, again['id'])
    check('so the roll is still three children', counts(db)['children'], 3)
    # The commit deletes and rewrites a child's enrolments, so the catalog is
    # the thing that could quietly grow a duplicate row per import.
    check('and the class catalog did not grow a second copy of itself',
          db.execute("SELECT count(*) AS n FROM class_sessions").fetchone()['n'], 2)
    check('nor did the enrolments double up',
          db.execute("SELECT count(*) AS n FROM class_enrollments").fetchone()['n'], 2)

    # ── Resolving the school unblocks its child ──────────────────────────────
    alias, err = roster_staging.resolve_school_alias(db, '????', school_name='Village School')
    check('resolving a placeholder school reports no error', err, None)
    third = roster_staging.stage(db, 'roster.xlsx', workbook(base_rows()))
    check('the child whose school was resolved is now a create',
          [r['child_name'] for r in third['rows'] if r['action'] == 'create'],
          ['Fable Cedar'])
    check('the one with no contact email is still blocked',
          third['totals']['actions']['blocked'], 1)
    roster_staging.commit(db, third['id'])
    check('and it lands', counts(db)['children'], 4)

    # ── An edit in the spreadsheet shows up as a change ──────────────────────
    edited = base_rows()
    edited[0] = row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Almond, Wren'},
                    Grade='K', Mon=6, Tue=4, Bus='x', Sex='F',
                    DOB=datetime(2019, 4, 2), Allergies='Tree Nut (EpiPen), Egg',
                    **{'Contact #1': 'Almond, Perry', 'Email #1': 'perry@example.test'})
    fourth = roster_staging.stage(db, 'roster.xlsx', workbook(edited))
    changed = next(r for r in fourth['rows'] if r['child_name'] == 'Wren Almond')
    check('an edited allergy is reported as a change',
          [c['field'] for c in changed['changes']], ['allergies'])
    check('and the row is an update', changed['action'], 'update')
    roster_staging.commit(db, fourth['id'])
    check('the new allergy is stored',
          db.execute("SELECT allergies FROM children WHERE name='Wren Almond'"
                     ).fetchone()['allergies'], 'Tree Nut (EpiPen), Egg')
    check('and the changed dismissal hour replaced the old one',
          db.execute("SELECT dismissal_time FROM registrations r JOIN children c "
                     "ON c.id=r.child_id WHERE c.name='Wren Almond' AND "
                     "r.day_of_week='Monday'").fetchone()['dismissal_time'], 6)

    # ── The withdrawn sheet ──────────────────────────────────────────────────
    withdrawn = [row(WITHDRAWN_HEADER, School='Brown',
                     **{"Child's Name": 'Almond, Rook'}, Grade=2,
                     Notes='moved out of district',
                     **{'Contact #1': 'Almond, Perry', 'Email #1': 'perry@example.test'})]
    fifth = roster_staging.stage(db, 'roster.xlsx', workbook([], withdrawn))
    check('a child on the No Longer sheet is a withdrawal',
          [r['action'] for r in fifth['rows']], ['withdraw'])
    roster_staging.commit(db, fifth['id'])
    rook = db.execute("SELECT active, withdrawn_at, withdrawn_reason FROM children "
                      "WHERE name='Rook Almond'").fetchone()
    check('withdrawing deactivates rather than deletes', rook['active'], 0)
    check('and records when', rook['withdrawn_at'] is not None, True)
    check('the child is still there to be looked up',
          db.execute("SELECT count(*) AS n FROM children").fetchone()['n'], 4)

    # ── The class catalog ────────────────────────────────────────────────────
    #
    # The identity of a class is (weekday, name, start time). Everything here is
    # a way that key gets it wrong, and each one loses a roster if it does.
    pin(cur, org)

    def classes_named(name):
        return db.execute(
            "SELECT id, name, day_of_week, start_time, end_time FROM class_sessions "
            " WHERE lower(name) = lower(%s) ORDER BY start_time NULLS FIRST",
            (name,)).fetchall()

    def enrolled_in(class_id):
        return db.execute(
            "SELECT count(*) AS n FROM class_enrollments WHERE class_session_id = %s",
            (class_id,)).fetchone()['n']

    def import_rows(rows):
        staged = roster_staging.stage(db, 'classes.xlsx', workbook(rows))
        roster_staging.commit(db, staged['id'])

    # Two sittings of one class on one weekday. Heather's spring roster has
    # eight such pairs; under the old (name, weekday) key each pair collapsed
    # into one row and one of the two rosters was silently merged into the other.
    import_rows([
        row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Elm, Early'}, Grade=1,
            Tue=4, **{'T - Class': 'HW Club 3p-4p'}, DOB=datetime(2019, 2, 2),
            **{'Contact #1': 'Elm, Ash', 'Email #1': 'elm@example.test'}),
        row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Elm, Later'}, Grade=2,
            Tue=5, **{'T - Class': 'HW Club 4p-5p'}, DOB=datetime(2018, 2, 2),
            **{'Contact #1': 'Elm, Ash', 'Email #1': 'elm@example.test'}),
    ])
    sittings = classes_named('HW Club')
    check('two sittings of one class on one weekday stay two classes',
          [(str(c['start_time']), str(c['end_time'])) for c in sittings],
          [('15:00:00', '16:00:00'), ('16:00:00', '17:00:00')])
    check('and each keeps its own roster',
          [enrolled_in(c['id']) for c in sittings], [1, 1])

    # `NO CLASS` is Heather saying the child comes and takes nothing. The day
    # has to survive — they are in care for the whole block — while the catalog
    # must not grow a class called "NO CLASS" for a counselor to be assigned to.
    import_rows([
        row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Fir, Quiet'}, Grade=1,
            Wed=5, **{'W - Class': 'NO CLASS'}, DOB=datetime(2019, 3, 3),
            **{'Contact #1': 'Fir, Bay', 'Email #1': 'fir@example.test'}),
    ])
    quiet = db.execute("SELECT id FROM children WHERE name = 'Quiet Fir'").fetchone()
    check('`NO CLASS` does not become a class', len(classes_named('NO CLASS')), 0)
    check('but the child still comes that day',
          [(r['day_of_week'], r['dismissal_time']) for r in db.execute(
              "SELECT day_of_week, dismissal_time FROM registrations WHERE child_id = %s",
              (quiet['id'],)).fetchall()],
          [('Wednesday', 5)])

    # sql/35's own flow: the file names a class with no hours, the importer
    # creates it, the admin fills the hours in on the Classes screen. Re-running
    # the same file must find *that* row. Matching on the start time alone would
    # miss it and create a second, blank class, moving every enrolment onto it.
    bare = [
        row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Gum, Sweet'}, Grade=1,
            Thur=5, **{'R - Class': 'Chess'}, DOB=datetime(2019, 4, 4),
            **{'Contact #1': 'Gum, Bay', 'Email #1': 'gum@example.test'}),
    ]
    import_rows(bare)
    chess = classes_named('Chess')
    check('a class named without hours still imports', len(chess), 1)
    check('with its hours left for the admin to fill in',
          (chess[0]['start_time'], chess[0]['end_time']), (None, None))
    db.execute("UPDATE class_sessions SET start_time = '15:30', end_time = '16:15' "
               " WHERE id = %s", (chess[0]['id'],))
    import_rows(bare)
    check('and re-importing adopts the admin\'s hours instead of duplicating it',
          [(c['id'], str(c['start_time'])) for c in classes_named('Chess')],
          [(chess[0]['id'], '15:30:00')])

    # The same class written two ways in one file — one of them carrying a
    # billing note — is one class and one enrolment, not two of each.
    import_rows([
        row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Holly, Twice'}, Grade=1,
            Fri=4, **{'F - Class': 'Yoga 4p-4:45p'}, DOB=datetime(2019, 5, 5),
            **{'Contact #1': 'Holly, Bay', 'Email #1': 'holly@example.test'}),
        row(ROSTER_HEADER, School='Brown', **{"Child's Name": 'Holly, Twice'}, Grade=1,
            Fri=4, **{'F - Class': 'Yoga 4p-4:45p (pro-rate as of 5/1)'}),
    ])
    yoga = classes_named('Yoga')
    check('a billing note does not fork the class', len(yoga), 1)
    check('and the child is in it once', enrolled_in(yoga[0]['id']), 1)

    # ── Tenancy ──────────────────────────────────────────────────────────────
    pin(cur, other)
    check('another JCC sees none of these children',
          db.execute("SELECT count(*) AS n FROM children").fetchone()['n'], 0)
    check('nor the import batches',
          db.execute("SELECT count(*) AS n FROM roster_import_batches").fetchone()['n'], 0)
    # A class_enrollments row is "this named child is in this room at this hour
    # on Tuesday", so it needs the same wall around it as the roster it is
    # derived from.
    check('nor the class catalog',
          db.execute("SELECT count(*) AS n FROM class_sessions").fetchone()['n'], 0)
    check('nor who is enrolled in it',
          db.execute("SELECT count(*) AS n FROM class_enrollments").fetchone()['n'], 0)
    check('nor the school aliases',
          db.execute("SELECT count(*) AS n FROM school_aliases").fetchone()['n'], 0)
    check('and preview refuses to load one across the boundary',
          roster_staging.preview(db, batch_id), None)

    with superadmin(cur):
        cur.execute("DELETE FROM organizations WHERE slug IN ('t-import','t-other')")
    conn.close()

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All roster staging checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
