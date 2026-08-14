"""Report what actually landed in the database, so a roster can be checked.

An import prints a summary once and then the numbers live only in the app. This
reads them back — counts, per-school splits, the weekday spread, the dismissal
hours, contacts, assignments and today's board — so they can be compared
against the spreadsheet they came from and against the previous run.

WHAT THIS CANNOT DO
    It cannot open Heather's file. It reports what the database says; a person
    still has to pick three children and check their school, grade, days and
    dismissal hours against the Excel. The point of this script is to make the
    other ninety-nine percent of that comparison arithmetic instead of reading.

IT IS READ-ONLY
    Every statement is a SELECT. It is meant to be safe to run against
    production during an afternoon, which is exactly when someone would want
    it.

    python3 scripts/verify_roster.py                # the only organization
    python3 scripts/verify_roster.py --org jccsn    # by slug
    python3 scripts/verify_roster.py --date 2026-08-03
"""

import argparse
import os
import sys
from datetime import datetime
from zoneinfo import ZoneInfo

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import psycopg2  # noqa: E402
import psycopg2.extras  # noqa: E402

WEEKDAYS = ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday')


def rows(cur, sql, params=()):
    cur.execute(sql, params)
    return cur.fetchall()


def one(cur, sql, params=()):
    r = rows(cur, sql, params)
    return list(r[0].values())[0] if r else None


def head(title):
    print()
    print(title)
    print('─' * len(title))


def table(pairs, width=34):
    for label, value in pairs:
        print(f'  {label:<{width}} {value}')


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--org', help='organization slug (default: the only one)')
    ap.add_argument('--date', help='date for the board section (default: today there)')
    args = ap.parse_args()

    url = os.environ.get('DATABASE_URL') or os.environ.get('ADMIN_DATABASE_URL')
    if not url:
        print('DATABASE_URL is required.')
        return 2

    conn = psycopg2.connect(url, cursor_factory=psycopg2.extras.RealDictCursor)
    conn.autocommit = True
    cur = conn.cursor()

    # Finding the organization is the one thing that has to look across all of
    # them, so it runs in the superadmin window and closes it immediately.
    cur.execute("SELECT set_config('app.is_superadmin','on',false)")
    orgs = rows(cur, "SELECT id, slug, name, timezone FROM organizations "
                     " WHERE status = 'active' ORDER BY id")
    cur.execute("SELECT set_config('app.is_superadmin','off',false)")

    if args.org:
        match = [o for o in orgs if o['slug'] == args.org]
    elif len(orgs) == 1:
        match = orgs
    else:
        print('More than one organization; pass --org with one of:')
        for o in orgs:
            print(f"  {o['slug']:<20} {o['name']}")
        return 2
    if not match:
        print(f'No active organization with slug {args.org!r}.')
        return 2
    org = match[0]
    cur.execute("SELECT set_config('app.organization_id',%s,false)", (str(org['id']),))

    tz = org['timezone'] or 'America/New_York'
    date_str = args.date or datetime.now(ZoneInfo(tz)).strftime('%Y-%m-%d')
    day_name = datetime.strptime(date_str, '%Y-%m-%d').strftime('%A')

    print(f"Roster check — {org['name']} ({org['slug']})")
    print(f"{date_str} ({day_name}), organization timezone {tz}")

    # ── Children ──────────────────────────────────────────────────────────
    head('Children')
    active = one(cur, "SELECT count(*) FROM children WHERE active = 1")
    withdrawn = one(cur, "SELECT count(*) FROM children WHERE active = 0")
    enrolled = one(cur, """
        SELECT count(DISTINCT c.id) FROM children c
          JOIN registrations r ON r.child_id = c.id WHERE c.active = 1
    """)
    table([
        ('Active', active),
        ('Withdrawn (No Longer)', withdrawn),
        ('Enrolled on at least one day', enrolled),
        # The gap the dashboard used to provoke: a roster arrives with children
        # whose class signups have not happened, and they are in no day view.
        ('Active but no day enrolled', active - enrolled),
    ])

    head('By school')
    for r in rows(cur, """
        SELECT s.name, count(c.id) FILTER (WHERE c.active = 1) AS n
          FROM schools s LEFT JOIN children c ON c.school_id = s.id
         GROUP BY s.id, s.name ORDER BY n DESC, s.name
    """):
        table([(r['name'], r['n'])])

    head('By weekday')
    for day in WEEKDAYS:
        n = one(cur, """
            SELECT count(*) FROM registrations r
              JOIN children c ON c.id = r.child_id
             WHERE c.active = 1 AND r.day_of_week = %s
        """, (day,))
        table([(day, n)])
    table([('Total registration rows',
            one(cur, "SELECT count(*) FROM registrations r "
                     " JOIN children c ON c.id = r.child_id WHERE c.active = 1"))])

    head('Dismissal hours')
    spread = rows(cur, """
        SELECT r.dismissal_time AS hour, count(*) AS n
          FROM registrations r JOIN children c ON c.id = r.child_id
         WHERE c.active = 1
         GROUP BY r.dismissal_time ORDER BY r.dismissal_time NULLS LAST
    """)
    for r in spread:
        label = f"{r['hour']}:00 PM" if r['hour'] is not None else 'no hour set'
        table([(label, r['n'])])
    if not spread:
        table([('none', 0)])

    # ── People ────────────────────────────────────────────────────────────
    head('Guardians')
    table([
        ('Parent accounts', one(cur, "SELECT count(*) FROM users WHERE role='parent'")),
        ('...who have set a password',
         one(cur, "SELECT count(*) FROM users WHERE role='parent' "
                  "  AND password_set_at IS NOT NULL")),
        ('Contact rows (priority 1)',
         one(cur, "SELECT count(*) FROM child_contacts WHERE priority = 1")),
        ('Contact rows (priority 2)',
         one(cur, "SELECT count(*) FROM child_contacts WHERE priority = 2")),
        ('Children sharing a parent with a sibling',
         one(cur, """
            SELECT count(*) FROM children c WHERE c.active = 1 AND EXISTS (
                SELECT 1 FROM children o
                 WHERE o.parent_id = c.parent_id AND o.id <> c.id AND o.active = 1)
         """)),
    ])

    head('Counselors')
    total_c = one(cur, "SELECT count(*) FROM users WHERE role='counselor'")
    assigned = one(cur, "SELECT count(DISTINCT counselor_id) FROM counselor_schools")
    table([
        ('Counselor accounts', total_c),
        ('...with at least one assignment', assigned),
        # Not "unassigned": with no rows at all a counselor covers every
        # school, which is deliberate but worth seeing the size of.
        ('...covering every school (no rows)', total_c - assigned),
        ('Temporary covers live today',
         one(cur, """
            SELECT count(*) FROM counselor_schools
             WHERE (effective_from IS NOT NULL OR effective_to IS NOT NULL)
               AND (effective_from IS NULL OR effective_from <= %s::date)
               AND (effective_to   IS NULL OR effective_to   >= %s::date)
         """, (date_str, date_str))),
    ])

    # ── The day ───────────────────────────────────────────────────────────
    head(f'The board for {day_name}')
    board = rows(cur, """
        WITH day AS (
            SELECT c.id, c.school_id,
                   r.id IS NOT NULL              AS scheduled,
                   COALESCE(ar.on_bus, 0) = 1    AS marked_in,
                   ar.checked_out_at IS NOT NULL AS released,
                   ar.status                     AS status
              FROM children c
              LEFT JOIN registrations r
                     ON r.child_id = c.id AND r.day_of_week = %s
              LEFT JOIN attendance_records ar
                     ON ar.child_id = c.id AND ar.attendance_date = %s
             WHERE c.active = 1
        )
        SELECT s.name,
               count(*) FILTER (WHERE d.scheduled)                    AS expected,
               count(*) FILTER (WHERE d.scheduled AND d.marked_in
                                  AND NOT d.released)                 AS in_building,
               count(*) FILTER (WHERE d.scheduled AND d.released)      AS picked_up,
               count(*) FILTER (WHERE d.scheduled
                                  AND d.status IN ('not_found','issue')) AS problems
          FROM day d JOIN schools s ON s.id = d.school_id
         GROUP BY s.id, s.name ORDER BY s.name
    """, (day_name, date_str))
    print(f"  {'School':<22}{'exp':>5}{'in':>5}{'out':>5}{'prob':>6}")
    for r in board:
        print(f"  {r['name']:<22}{r['expected']:>5}{r['in_building']:>5}"
              f"{r['picked_up']:>5}{r['problems']:>6}")

    # ── Things a person should look at ────────────────────────────────────
    head('Worth a look')
    notes = []
    placeholder = rows(cur, "SELECT alias FROM school_aliases WHERE school_id IS NULL")
    if placeholder:
        notes.append(f"{len(placeholder)} school name(s) still unresolved: "
                     + ', '.join(a['alias'] for a in placeholder))
    no_days = active - enrolled
    if no_days:
        notes.append(f"{no_days} active children are enrolled on no weekday — "
                     "they appear in no roster, board or headcount.")
    no_dob = one(cur, "SELECT count(*) FROM children WHERE active = 1 AND dob IS NULL")
    if no_dob:
        notes.append(f"{no_dob} active children have no date of birth.")
    empty_schools = rows(cur, """
        SELECT s.name FROM schools s
         WHERE NOT EXISTS (SELECT 1 FROM children c
                            WHERE c.school_id = s.id AND c.active = 1)
    """)
    if empty_schools:
        notes.append('School(s) with no active children: '
                     + ', '.join(s['name'] for s in empty_schools))
    never_set = one(cur, "SELECT count(*) FROM users WHERE role = 'counselor' "
                         "  AND password_set_at IS NULL")
    if never_set:
        notes.append(f"{never_set} counselor(s) have never set a password and "
                     "cannot sign in yet.")
    if notes:
        for n in notes:
            print(f'  • {n}')
    else:
        print('  Nothing stands out.')

    print()
    print('Now open three children in the app and check their school, grade,')
    print('days and dismissal hours against the spreadsheet. That part is')
    print('reading, and no script can do it for you.')

    cur.close()
    conn.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
