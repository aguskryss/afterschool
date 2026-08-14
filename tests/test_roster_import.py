"""Roster parser tests.

The fixture below is synthetic. The header rows are copied verbatim from the
JCC's two sheets — headers are not personal data and getting them exactly right
is the whole point of the test — but every child in it is invented. No real
roster is readable from this repository, by design (docs/source-files/ is in
.gitignore), and no test may ever depend on one.

What is checked here is the set of things the two source files were found to
actually do, each of which would silently corrupt an import if handled by the
obvious reading:

  • the tail of the sheet is one column further right than the spec says, so
    `complete` is AD and Contact #1 is AE — a positional reader imports the
    checklist as a parent and loses Email #2
  • the withdrawn sheet has a different column order, two fewer columns, day
    columns headed by single letters, and `Notes` twice
  • the day columns are dismissal hours, not enrolment flags, and carry `**`
  • a row is a child only if School is filled in *and* it is not a legend line
  • a child with two classes is two rows (R4)

    python3 tests/test_roster_import.py
"""

import json
import os
import sys
from datetime import date, datetime

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server import roster_import as ri

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected!r}, got {actual!r}")
    if not ok:
        failures.append(label)


# ─────────────────────────────────────────────────────────────────────────────
# The fixture
# ─────────────────────────────────────────────────────────────────────────────

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

# Two fewer columns, a different starting column, single-letter days, a stray
# leading space, `(pg 3)` instead of `(pg 2)`, and `Notes` in two places.
WITHDRAWN_HEADER = [
    'Notes', 'School', "Child's Name", 'Grade',
    'M', 'M - Class', 'T', 'T - Class', 'W', 'W - Class',
    'R', ' R - Class', 'F', 'F - Class',
    'Bus', 'Sex', 'Notes', 'DOB', 'Allergies',
    'Regist Rcvd', 'Regist Fee Chged', 'Member? Y/N/Sent', 'Pick up (pg 3)',
    'First Aid (pg 3)', 'Medication (pg 4)', 'Physical', 'Imm.', 'complete',
    'Contact #1', 'Phone #1', 'Email #1', 'Contact #2', 'Phone #2', 'Email #2',
]


def row(header, **values):
    """Build a row by header name, so the fixture reads like the spreadsheet."""
    cells = [None] * len(header)
    for name, value in values.items():
        name = name.replace('_', ' ')
        for index, title in enumerate(header):
            if ri.normalize_header(title) == ri.normalize_header(name):
                cells[index] = value
                break
        else:  # pragma: no cover - a typo in the fixture, not a parser result
            raise AssertionError(f"no column named {name!r}")
    return cells


def roster_row(**values):
    return row(ROSTER_HEADER, **values)


# Row numbers below are 1-based and match what the assertions quote back.
ROSTER_ROWS = [
    ROSTER_HEADER,                                                        # 1
    # A plain child: bus rider, one class-free day, full paperwork.
    roster_row(                                                           # 2
        **{'?? for parents': 'SG: Returning 2026-27'},
        School='Brown', **{"Child's Name": 'Almond, Wren'}, Grade='K',
        Mon=5, Tue=4, Bus='x', Sex='F', DOB=datetime(2019, 4, 2),
        Allergies='Tree Nut (EpiPen)', Notes='sibling of Almond, Rook',
        **{'Regist Rcvd': datetime(2026, 5, 14), 'Member? Y/N/Sent': 'Y',
           'Pick up (pg 2)': 'x', 'First Aid (pg 2)': 'MISSING',
           'Photo': 'requested', 'complete': 'x'},
        **{'Contact #1': 'Almond, Perry', 'Phone #1': '555-0100',
           'Email #1': 'perry@example.test',
           'Contact #2': 'Almond, Sage', 'Phone #2': '555-0101',
           'Email #2': 'sage@example.test'},
    ),
    # Same child twice: two classes on Wednesday (R4). Grade is written as an
    # int here and DOB as text, both of which the real file does.
    roster_row(                                                           # 3
        School='Glover', **{"Child's Name": 'Birch, Juniper'}, Grade=3,
        Wed='5**', **{'W - Class': 'Soccer 3:15p-4p'},
        Bus='NO', Sex='M', DOB='7/19/2017',
        **{'Contact #1': 'Birch, Wren', 'Phone #1': '555-0110'},
    ),
    roster_row(                                                           # 4
        School='Glover', **{"Child's Name": 'Birch, Juniper'}, Grade=3,
        Wed='5**', **{'W - Class': 'Floor Hockey 4p-4:45p'},
        Thur=6, Bus='NO',
    ),
    # Drop-off arrival, grade typed as 0 rather than K, an unreadable Bus cell.
    roster_row(                                                           # 5
        School='Brown - Drop Off', **{"Child's Name": 'Cedar, Fable'}, Grade=0,
        Fri=6, Bus='??', Sex='F', DOB=datetime(2020, 1, 30),
        **{'Contact #1': 'Cedar, Rowan', 'Email #1': 'rowan@example.test'},
    ),
    # School still to be resolved, and a day cell that is not an hour at all.
    roster_row(                                                           # 6
        School='????', **{"Child's Name": 'Dogwood, Alder'}, Grade=5,
        Mon='Online ', Tue=3, Bus='x', DOB=datetime(2014, 11, 5),
        **{'Contact #1': 'Dogwood, Hazel', 'Phone #1': '555-0120'},
    ),
    # Flagged REMOVE with no day enrolled: imports, appears in no daily view.
    roster_row(                                                           # 7
        **{'?? for parents': 'SG: REMOVE'},
        School='SPS', **{"Child's Name": 'Elder, Maple'}, Grade=2,
        Sex='M', DOB=datetime(2018, 8, 21),
        **{'Contact #1': 'Elder, Ash', 'Phone #1': '555-0130'},
    ),
    # A contact with a phone and no name, which NOT NULL would otherwise drop.
    roster_row(                                                           # 8
        School='EHS', **{"Child's Name": 'Fir, Linden'}, Grade=1,
        Mon=4, DOB=datetime(2019, 2, 2), **{'Phone #1': '555-0140'},
    ),
    # No name at all: blocked, not skipped — someone has to look at it.
    roster_row(                                                           # 9
        School='SPS', Grade=4, Mon=5, DOB=datetime(2016, 6, 6),
    ),
    # The two legend lines that carry something in School.
    roster_row(School='REG', **{"Child's Name": 'BUS ONLY - EHS'}),       # 10
    roster_row(School='NUMBERS', **{"Child's Name": 'Bball 3:15p-4p'}),   # 11
    [None] * len(ROSTER_HEADER),                                          # 12
    # The scratch block at the foot: no school, names the other way round.
    roster_row(**{"Child's Name": 'Wren Almond'}, Grade='Enrolled'),      # 13
    roster_row(**{"Child's Name": 'Juniper Birch'}),                      # 14
    roster_row(**{"Child's Name": 'Juniper Birch'}, Grade='waiting on HG'),  # 15
]

WITHDRAWN_ROWS = [
    WITHDRAWN_HEADER,
    row(WITHDRAWN_HEADER,
        Notes='moved out of district', School='Glover',
        **{"Child's Name": 'Hemlock, Bay'}, Grade=2,
        M=4, T=4, Bus='x', Sex='F', DOB=datetime(2018, 3, 12),
        **{'Contact #1': 'Hemlock, Wren', 'Phone #1': '555-0150'}),
]

WORKBOOK = [('J Adv Roster', ROSTER_ROWS), ('No Longer', WITHDRAWN_ROWS)]


def main() -> int:
    # ── Header resolution ────────────────────────────────────────────────────
    columns, notices = ri.resolve_columns(ROSTER_HEADER, sheet='J Adv Roster')

    check("School resolves to column B", columns.fields.get('school'), 1)
    check("Child's Name resolves to column C", columns.fields.get('name'), 2)
    check("the staff flag column is read, not skipped",
          columns.fields.get('roster_flag'), 0)

    # The one the spec gets wrong. If `complete` lands on AC, Contact #1 lands
    # on AD and every child imports with the checklist as their parent.
    check("`complete` is column AD, one right of where the spec puts it",
          ri.column_letter(columns.compliance['complete']), 'AD')
    check("Contact #1 is column AE", ri.column_letter(columns.contacts[0].name), 'AE')
    check("Email #2 is column AJ and is read",
          ri.column_letter(columns.contacts[1].email), 'AJ')

    check("both contacts are found", len(columns.contacts), 2)
    check("the day columns are the five weekdays",
          sorted(columns.days, key=ri.WEEKDAYS.index), list(ri.WEEKDAYS))
    check("the class columns pair with them",
          sorted(columns.classes, key=ri.WEEKDAYS.index), list(ri.WEEKDAYS))
    check("all ten checklist items are mapped", len(columns.compliance), 11)
    check("no column is left unrecognised", columns.unknown, [])
    check("a clean header row raises nothing above info",
          [n.code for n in notices if n.level != ri.INFO], [])

    # ── The withdrawn sheet, which is shaped differently ─────────────────────
    wcolumns, wnotices = ri.resolve_columns(WITHDRAWN_HEADER, sheet='No Longer')
    check("single-letter day headers resolve, R being Thursday",
          {day: ri.column_letter(i) for day, i in sorted(wcolumns.days.items())},
          {'Friday': 'M', 'Monday': 'E', 'Thursday': 'K',
           'Tuesday': 'G', 'Wednesday': 'I'})
    check("a leading space in ' R - Class' does not hide the column",
          ri.column_letter(wcolumns.classes['Thursday']), 'L')
    check("`Pick up (pg 3)` maps to the same item as `(pg 2)`",
          ri.column_letter(wcolumns.compliance['pickup_form']), 'W')
    check("Contact #1 is where this sheet puts it, not where the other one does",
          ri.column_letter(wcolumns.contacts[0].name), 'AC')
    check("the repeated `Notes` header is reported",
          [n.code for n in wnotices if n.code == 'duplicate_header'],
          ['duplicate_header'])
    check("and the first occurrence is the one used",
          wcolumns.fields.get('notes'), 0)

    # ── Cell readers, one rule at a time ─────────────────────────────────────
    check("`5**` is five o'clock with the multi-class mark",
          ri.parse_dismissal('5**'), ((5, True), None))
    check("a bare 5 is five o'clock", ri.parse_dismissal(5), ((5, False), None))
    check("5.0 is not a different hour from 5", ri.parse_dismissal(5.0), ((5, False), None))
    check("an empty day cell is not enrolled, and not a complaint",
          ri.parse_dismissal(None), ((None, False), None))
    check("`Online ` is not an hour and says so",
          ri.parse_dismissal('Online '), ((None, False), 'dismissal_unreadable'))
    check("7pm is outside the four hours",
          ri.parse_dismissal(7), ((None, False), 'dismissal_out_of_range'))

    check("K is grade zero, spelled K", ri.parse_grade('K'), (('K', 0), None))
    check("0 is grade zero, spelled 0", ri.parse_grade(0), (('0', 0), None))
    check("5 is a grade even though the spec stops at 4",
          ri.parse_grade(5), (('5', 5), None))
    check("an unreadable grade keeps its spelling and loses its number",
          ri.parse_grade('waiting on HG'), (('waiting on HG', None), 'grade_unrecognized'))

    check("`Brown - Drop Off` is Brown, arriving by car",
          ri.parse_school('Brown - Drop Off'), (('Brown', 'dropoff'), None))
    check("`D.O.` on the attendance sheets is arrival with no school named",
          ri.parse_school('D.O.'), ((None, 'dropoff'), None))
    check("`????` is a school still to be chosen, not a junk row",
          ri.parse_school('????'), (('????', None), 'school_placeholder'))

    check("`x` rides the bus", ri.parse_bus('x'), (True, None))
    check("`NO` does not", ri.parse_bus('NO'), (False, None))
    check("`??` is nobody's answer yet", ri.parse_bus('??'), (None, 'bus_unreadable'))

    check("a date of birth typed as text still parses",
          ri.parse_dob('7/19/2017'), (date(2017, 7, 19), None))
    check("a date of birth typed as a date parses",
          ri.parse_dob(datetime(2017, 7, 19)), (date(2017, 7, 19), None))

    check("a dated checklist cell records the date",
          ri.parse_compliance(datetime(2026, 5, 14)),
          (('done', date(2026, 5, 14), '2026-05-14'), None))
    check("an `x` is done with no date", ri.parse_compliance('x'), (('done', None, 'x'), None))
    check("`MISSING` is a deliberate word, not a blank",
          ri.parse_compliance('MISSING'), (('missing', None, 'MISSING'), None))
    check("`requested updated` is pending",
          ri.parse_compliance('requested updated'),
          (('pending', None, 'requested updated'), None))
    check("an empty checklist cell writes no row at all",
          ri.parse_compliance(None), (None, None))
    check("anything else is kept verbatim rather than guessed at",
          ri.parse_compliance('see Heather'),
          (('other', None, 'see Heather'), 'compliance_unreadable'))
    # The medication column holds the medication, not a tick. Read as 'other'
    # these children turn up on a list of families who still owe paperwork.
    check("a named medication is the form being on file",
          ri.parse_compliance('Epi-Pen', item='medication'),
          (('done', None, 'Epi-Pen'), 'medication_named'))
    check("and the same text in any other column stays unrecognised",
          ri.parse_compliance('Epi-Pen', item='physical'),
          (('other', None, 'Epi-Pen'), 'compliance_unreadable'))
    # A year with a digit missing, which the real roster has one of. There is
    # no right answer, and picking one invents a child's date of birth.
    check("a truncated year is refused rather than guessed",
          ri.parse_dob('3/07/201'), (None, 'dob_unreadable'))

    check("`Last, First` splits", ri.parse_person_name('Almond, Wren'),
          (('Almond', 'Wren'), None))
    check("a name with no comma is kept whole and flagged",
          ri.parse_person_name('BUS ONLY - EHS'),
          (('BUS ONLY - EHS', None), 'name_not_last_first'))

    # ── The sheet as a whole ─────────────────────────────────────────────────
    parse = ri.parse_rows_by_sheet(WORKBOOK)
    roster = parse.sheets[0]
    by_name = {c.name: c for c in roster.children}

    check("the scratch block at the foot is not children",
          roster.totals['draft_rows'], 3)
    check("the two legend lines are not children either",
          roster.totals['legend_rows'], 2)
    check("what is left is the roster", roster.totals['children'], 7)
    check("the duplicated row was folded in, not counted twice",
          roster.totals['rows_merged'], 1)
    check("the row with no name is blocked rather than dropped",
          roster.totals['blocked'], 1)
    check("children with no day enrolled are counted, not hidden",
          roster.totals['children_without_days'], 1)

    wren = by_name['Wren Almond']
    check("the name splits into halves", (wren.last_name, wren.first_name),
          ('Almond', 'Wren'))
    check("kindergarten is grade 0 with its own label",
          (wren.grade_label, wren.grade_num), ('K', 0))
    check("the allergy comes across", wren.allergies, 'Tree Nut (EpiPen)')
    check("the bus flag becomes an arrival mode",
          (wren.bus_rider, wren.arrival_mode), (True, 'bus'))
    check("the billing column is stored and does nothing",
          wren.roster_flag, 'SG: Returning 2026-27')
    check("only the enrolled days become registrations",
          sorted((r.day_of_week, r.dismissal_time) for r in wren.registrations),
          [('Monday', 5), ('Tuesday', 4)])
    check("both contacts land, in priority order",
          [(c.priority, c.name) for c in wren.contacts],
          [(1, 'Almond, Perry'), (2, 'Almond, Sage')])
    check("a dated checklist item keeps its date",
          [(c.item, c.status, c.recorded_on) for c in wren.compliance
           if c.item == 'registration'],
          [('registration', 'done', date(2026, 5, 14))])
    check("`MISSING` survives as a status of its own",
          [(c.item, c.status) for c in wren.compliance if c.item == 'first_aid'],
          [('first_aid', 'missing')])
    check("blank checklist cells write nothing",
          sorted(c.item for c in wren.compliance),
          ['complete', 'first_aid', 'membership', 'photo', 'pickup_form', 'registration'])

    juniper = by_name['Juniper Birch']
    check("the two rows of a two-class child are one child",
          len(juniper.source_rows), 2)
    check("and the row numbers point back at the spreadsheet",
          juniper.source_rows, [3, 4])
    check("both classes end up on the same day, with their hours split off",
          [[(c.name, c.start_time, c.end_time) for c in r.classes]
           for r in juniper.registrations if r.day_of_week == 'Wednesday'],
          [[('Soccer', '15:15', '16:00'), ('Floor Hockey', '16:00', '16:45')]])
    check("the second row's own day is kept too",
          sorted((r.day_of_week, r.dismissal_time) for r in juniper.registrations),
          [('Thursday', 6), ('Wednesday', 5)])
    check("`**` is carried as a hint, not as data",
          [r.starred for r in juniper.registrations if r.day_of_week == 'Wednesday'],
          [True])
    check("a contact given on only one of the two rows still lands",
          [(c.priority, c.name, c.phone) for c in juniper.contacts],
          [(1, 'Birch, Wren', '555-0110')])
    check("a date of birth typed as text on the roster parses",
          juniper.dob, date(2017, 7, 19))

    fable = by_name['Fable Cedar']
    check("the drop-off suffix leaves the school name clean", fable.school_token, 'Brown')
    check("while the cell Heather typed is kept to quote back at her",
          fable.school_raw, 'Brown - Drop Off')
    check("and becomes the arrival mode", fable.arrival_mode, 'dropoff')
    check("grade 0 is the same grade as K", fable.grade_num, 0)
    check("an unreadable Bus cell is not read as `no`", fable.bus_rider, None)
    check("and it is reported",
          [n.code for n in fable.notices], ['bus_unreadable'])

    alder = by_name['Alder Dogwood']
    check("a school that has to be resolved is flagged, not dropped",
          sorted(n.code for n in alder.notices),
          ['dismissal_unreadable', 'school_placeholder'])
    check("the day that could not be read is not an enrolment",
          [r.day_of_week for r in alder.registrations], ['Tuesday'])
    check("the 3 o'clock group parses",
          [r.dismissal_time for r in alder.registrations], [3])

    maple = by_name['Maple Elder']
    check("a REMOVE-flagged child imports", maple.status, 'active')
    check("with no enrolled day, so no daily view will show them",
          maple.enrolled_days, [])

    linden = by_name['Linden Fir']
    check("a contact with a phone and no name is not thrown away",
          [(c.priority, c.name, c.phone) for c in linden.contacts],
          [(1, '555-0140', '555-0140')])
    check("and the missing name is reported",
          [n.code for n in linden.notices], ['contact_missing_name'])

    nameless = [c for c in roster.children if c.blocked]
    check("exactly one row is blocked", len(nameless), 1)
    check("and it says why, on the row number Heather can go to",
          [(n.code, n.row) for n in nameless[0].notices if n.level == ri.ERROR],
          [('child_name_missing', 9)])

    # ── A disagreement between two rows of the same child ────────────────────
    conflicting = [
        ROSTER_HEADER,
        roster_row(School='Glover', **{"Child's Name": 'Birch, Juniper'}, Grade=3,
                   Wed=5, **{'W - Class': 'Soccer'}, DOB=datetime(2017, 7, 19)),
        roster_row(School='Glover', **{"Child's Name": 'Birch, Juniper'}, Grade=3,
                   Wed=6, **{'W - Class': 'Floor Hockey'}),
    ]
    merged = ri.parse_sheet(conflicting, 'J Adv Roster')
    check("two rows disagreeing on the hour is reported, not silently resolved",
          [n.code for n in merged.children[0].notices if n.code != 'class_time_missing'],
          ['dismissal_conflict'])
    check("and the first row's hour is the one kept",
          [r.dismissal_time for r in merged.children[0].registrations], [5])

    # ── The withdrawn sheet ──────────────────────────────────────────────────
    withdrawn = parse.sheets[1]
    check("the `No Longer` sheet is read as withdrawals", withdrawn.status, 'withdrawn')
    check("its children parse through the other column order",
          [(c.name, c.grade_num, c.dob) for c in withdrawn.children],
          [('Bay Hemlock', 2, date(2018, 3, 12))])
    check("including the single-letter day columns",
          sorted((r.day_of_week, r.dismissal_time)
                 for r in withdrawn.children[0].registrations),
          [('Monday', 4), ('Tuesday', 4)])
    check("they are archived, never counted as active",
          (parse.totals['children'], parse.totals['withdrawn']), (7, 1))

    # ── Which sheets get read (the bug that made this a two-line import) ─────
    #
    # This used to be decided by the sheet's *title*, needing the word `roster`
    # in it. Heather's real workbook names its sheets `Spring 2025-26` and
    # `No Longer`: the second matched, so the filtered list came back non-empty,
    # so the "nothing matched, read everything" fallback never fired, and the
    # entire roster was dropped in silence. 110 children became 0.
    check("a roster sheet named for its season is still a roster sheet",
          ri.is_roster_sheet([ROSTER_HEADER, roster_row(
              School='Brown', **{"Child's Name": 'Oak, Rowan'}, Grade=1)]),
          True)
    check("and so is one with no recognisable title at all",
          ri.is_roster_sheet([WITHDRAWN_HEADER]), True)
    check("a scratch tab is not, so it is still kept out",
          ri.is_roster_sheet([['Class', 'Enrolled'], ['Soccer 3:15p-4p', 19]]),
          False)
    check("the season sheet is still read as active, the withdrawn one as withdrawn",
          (ri.sheet_status('Spring 2025-26'), ri.sheet_status('No Longer')),
          ('active', 'withdrawn'))

    # ── Class cells: name, hours, and what is not a class ────────────────────
    def klass(cell):
        parsed, code = ri.parse_class_cell(cell)
        if parsed is None:
            return (None, code)
        return ((parsed.name, parsed.start_time, parsed.end_time), code)

    check("the hours Heather writes into the class name are read out of it",
          klass('Soccer 3:15p-4p'), (('Soccer', '15:15', '16:00'), None))
    check("a start with no am/pm takes it from the end, so 4p-5p is the afternoon",
          klass('HW Club 4p-5p'), (('HW Club', '16:00', '17:00'), None))
    check("half hours on both sides parse",
          klass('Pvt Swim 3:30p-4:30p'), (('Pvt Swim', '15:30', '16:30'), None))
    check("a name with no hours in it stays legal and keeps its whole name",
          klass('Chess'), (('Chess', None, None), 'class_time_missing'))
    check("`NO CLASS` is not a class",
          klass('NO CLASS'), (None, 'class_not_a_class'))
    check("neither is a bus note",
          klass('BUS ONLY - EHS'), (None, 'class_not_a_class'))
    check("a billing note comes off the name and is reported",
          klass('Soccer 3:15p-4p (pro-rate as of 5/1)'),
          (('Soccer', '15:15', '16:00'), 'class_annotation_stripped'))
    check("including one written in front of the name",
          klass('REMOVE A&C 3:15p-4p (No refund)'),
          (('A&C', '15:15', '16:00'), 'class_annotation_stripped'))
    check("and one that only dates the change",
          klass('Soccer 3:15p-4p (as of 4/15)'),
          (('Soccer', '15:15', '16:00'), 'class_annotation_stripped'))

    # The parentheses that are part of the name, not notes about it. A general
    # "strip anything parenthesised" merges three swim levels into one class and
    # puts beginners in the deep end of the roster.
    check("a swim level in parentheses is part of the class name",
          [klass(f'Swim T (Mini {shade}) 3:15p-4p')[0][0]
           for shade in ('White', 'Green', 'Black')],
          ['Swim T (Mini White)', 'Swim T (Mini Green)', 'Swim T (Mini Black)'])
    check("and so is the style of a dance class",
          [klass('KIM (Hip Hop) 4p-4:45p')[0][0],
           klass('KIM (Dance Combo) 3:15p-4:15p')[0][0]],
          ['KIM (Hip Hop)', 'KIM (Dance Combo)'])
    check("a backwards range is a typo, so no hours are invented from it",
          klass('Soccer 5p-4p'),
          (('Soccer 5p-4p', None, None), 'class_time_unreadable'))

    # ── The same class twice on one weekday ──────────────────────────────────
    #
    # `HW Club 3p-4p` and `HW Club 4p-5p` both run on Tuesday. They are two
    # classes with two rosters, and the start time is what tells them apart.
    twice = ri.parse_sheet([
        ROSTER_HEADER,
        roster_row(School='Brown', **{"Child's Name": 'Oak, Rowan'}, Grade=1,
                   Tue='5**', **{'T - Class': 'HW Club 3p-4p'},
                   DOB=datetime(2018, 5, 1)),
        roster_row(School='Brown', **{"Child's Name": 'Oak, Rowan'}, Grade=1,
                   Tue='5**', **{'T - Class': 'HW Club 4p-5p'}),
    ], 'Spring 2025-26')
    check("two sittings of one class on one day stay two classes",
          [(c.name, c.start_time) for r in twice.children[0].registrations
           for c in r.classes],
          [('HW Club', '15:00'), ('HW Club', '16:00')])

    repeated = ri.parse_sheet([
        ROSTER_HEADER,
        roster_row(School='Brown', **{"Child's Name": 'Oak, Rowan'}, Grade=1,
                   Tue=5, **{'T - Class': 'Soccer 3:15p-4p'},
                   DOB=datetime(2018, 5, 1)),
        roster_row(School='Brown', **{"Child's Name": 'Oak, Rowan'}, Grade=1,
                   Tue=5, **{'T - Class': 'Soccer 3:15p-4p (pro-rate as of 5/1)'}),
    ], 'Spring 2025-26')
    check("but the same class written twice is one enrolment",
          [(c.name, c.start_time) for r in repeated.children[0].registrations
           for c in r.classes],
          [('Soccer', '15:15')])

    # ── Ditto marks ──────────────────────────────────────────────────────────
    #
    # The second row of a two-row child carries `--` in every column it repeats.
    # Read literally that is ~750 notices on the real file, each saying a date of
    # birth of `--` is unreadable, on a screen whose job is the few that matter.
    check("a ditto mark reads as an empty cell", ri.cell_text('--'), None)
    dittoed = ri.parse_sheet([
        ROSTER_HEADER,
        roster_row(School='Brown', **{"Child's Name": 'Oak, Rowan'}, Grade=1,
                   Tue=5, **{'T - Class': 'Soccer 3:15p-4p'},
                   DOB=datetime(2018, 5, 1), Sex='F', Bus='x'),
        roster_row(School='Brown', **{"Child's Name": 'Oak, Rowan'}, Grade=1,
                   Thur=5, **{'R - Class': 'Yoga 4p-4:45p'},
                   DOB='--', Sex='--', Bus='--', Notes='--'),
    ], 'Spring 2025-26')
    rowan = dittoed.children[0]
    check("so a continuation row raises no notices about it",
          [n.code for n in rowan.notices], [])
    check("and the first row's values are the ones kept",
          (rowan.dob, rowan.sex, rowan.bus_rider), (date(2018, 5, 1), 'F', True))
    check("while the continuation row's own day still lands",
          sorted(r.day_of_week for r in rowan.registrations),
          ['Thursday', 'Tuesday'])

    # ── A billing note on the dismissal hour ─────────────────────────────────
    #
    # Same note, different column: `5 (remove as of 5/1 - charge change fee)`.
    # Read literally the child loses the one field the daily board needs.
    check("a billing note on the hour does not cost the child their hour",
          ri.parse_dismissal('5 (remove as of 5/1 - charge change fee)'),
          ((5, False), 'dismissal_annotation_stripped'))
    check("a plain hour is untouched", ri.parse_dismissal('4'), ((4, False), None))
    check("and a genuinely unreadable one is still reported",
          ri.parse_dismissal('sometime'), ((None, False), 'dismissal_unreadable'))

    # ── The summary the review screen shows ──────────────────────────────────
    check("the schools seen are reported for aliasing",
          parse.totals['school_tokens'],
          ['????', 'brown', 'ehs', 'glover', 'sps'])
    check("every parsed row survives a round trip through JSONB",
          json.loads(json.dumps(parse.as_dict()))['totals']['children'], 7)

    # Nothing in this module may reach a database or a request.
    source = open(ri.__file__, encoding='utf-8').read()
    check("the parser imports nothing from the app or the database layer",
          [line for line in source.splitlines()
           if line.startswith(('import ', 'from '))
           and any(w in line for w in ('database', 'app', 'flask', 'psycopg'))],
          [])

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print("All roster parser checks passed.")
    return 0


if __name__ == '__main__':
    sys.exit(main())
