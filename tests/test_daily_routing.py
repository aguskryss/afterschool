"""Tests for the pure day-logic module. Needs no database.

`parse_class_times` reads a class's hours out of the free text the office typed
into the roster. It exists to SUGGEST hours an admin confirms, never to write
them, because a wrong `end_time` sends a child to a care room their parent is not
standing in — the same reason `sql/35` left the column NULL instead of
defaulting it.

So the property under test there is not "does it parse" but **does it refuse**.
Every case below that expects None is a case where a confident guess would be
worse than an empty field.

`resolve_care_room` and `care_blocks` decide where a grade waits. Their property
is that the answer is **stable and total**: the same rules always resolve to the
same room, and a grade nobody has a rule for comes back as uncovered instead of
being quietly folded into a neighbour's room.

    python3 tests/test_daily_routing.py
"""

import os
import re
import sys
from datetime import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from server.daily_routing import (  # noqa: E402
    BLOCK_BOUNDS,
    DEST_CARE,
    DEST_CLASS,
    DEST_PARENTS,
    DEST_UNKNOWN,
    DISMISSAL_TIMES,
    TIME_BLOCKS,
    W_CLASS_AFTER_DISMISSAL,
    W_CLASS_NO_END,
    W_CLASS_OVERLAP,
    W_NO_CARE_ROOM,
    W_NO_DISMISSAL,
    W_NO_GRADE,
    assignment_span,
    block_of,
    care_blocks,
    care_candidates,
    care_segments,
    covered_blocks,
    dismiss_to,
    dismissal_clock,
    grade_label,
    grade_range_label,
    next_chained_class,
    parse_class_times,
    plan_day,
    resolve_care_room,
    staff_gaps,
    staff_overlaps,
)

OCEAN, GYM, PLAYGROUND = 1, 2, 3
ROOMS = {OCEAN: 'Ocean Room', GYM: 'Gym', PLAYGROUND: 'Playground'}


def at(text):
    """'15:30' as a time. The sheets' own notation is tested elsewhere."""
    h, m = text.split(':')
    return time(int(h), int(m))


def klass(id, name, start=None, end=None, day='Monday'):
    """One `class_sessions` row. start/end None is the un-filled-in catalogue."""
    return {'id': id, 'name': name, 'day_of_week': day,
            'start_time': at(start) if start else None,
            'end_time': at(end) if end else None}


def room(room_id):
    """A resolved care room, as `resolve_care_room` hands one over."""
    return {'id': 99, 'room_id': room_id, 'room_name': ROOMS[room_id]}


# ── The classes really on the June workbook's Monday sheets ────────────────
BBALL = klass(1, 'Bball 3:15p-4p', '15:15', '16:00')
CRAFTING = klass(2, 'Crafting 4p-4:45p', '16:00', '16:45')
MINI = klass(3, 'Mini Masters 4p-4:45p', '16:00', '16:45')
TINKER = klass(4, 'Tinker Titans 3:15p-4p', '15:15', '16:00')
SWIM = klass(5, 'Swim L1/2 3p-3:30p', '15:00', '15:30')
CHESS = klass(6, 'Chess')  # in the catalogue, hours never filled in
MONDAY_CLASSES = [BBALL, CRAFTING, MINI, TINKER, SWIM, CHESS]


def rule(id, block, lo, hi, room, day=None, priority=100):
    """One `care_assignment_rules` row, as the endpoint hands it over."""
    return {
        'id': id, 'time_block': block, 'grade_min': lo, 'grade_max': hi,
        'room_id': room, 'day_of_week': day, 'priority': priority,
    }


#: The five rules in the Care photo's headers, as all-week rules.
PHOTO_RULES = [
    rule(1, '3-4', 0, 0, OCEAN),   # Ocean Room (K)
    rule(2, '3-4', 1, 4, GYM),     # Gym (1-4)
    rule(3, '4-5', 0, 1, OCEAN),   # Ocean Room (K-1)
    rule(4, '4-5', 2, 4, GYM),     # Gym (2-4)
    rule(5, '5-6', 0, 4, OCEAN),   # Ocean Room (K-4)
]

PHOTO_GRADES = [0, 1, 2, 3, 4]


def teaches(label, start, end):
    """One staff shift on a class, as `_staff_people` assembles one."""
    return {'kind': 'class', 'id': 1, 'label': label,
            'time_block': None,
            'start_time': at(start) if start else None,
            'end_time': at(end) if end else None}


def covers(label, block):
    """One staff shift in a care room, which is always a whole block."""
    start, end = BLOCK_BOUNDS[block]
    return {'kind': 'room', 'id': 2, 'label': label, 'time_block': block,
            'start_time': start, 'end_time': end}


#: Lillian's real Monday: two swim lessons back to back, both inside 3-4, which
#: `M-Staff` writes as the single cell `Swim L/T`.
SWIM_L = teaches('Swim L1/2 3p-3:30p', '15:00', '15:30')
SWIM_T = teaches('Swim L3 3:30p-4p', '15:30', '16:00')

failures: list[str] = []


def check(label: str, actual, expected) -> None:
    ok = actual == expected
    print(f"{'PASS' if ok else 'FAIL'}  {label}: expected {expected!r}, got {actual!r}")
    if not ok:
        failures.append(label)


def main() -> int:
    # ── The names that are really in the roster ────────────────────────────
    # Taken off the June attendance workbook's own sheets, which is the only
    # sample of this column that exists.
    real = {
        'Crafting 4p-4:45p': (time(16, 0), time(16, 45)),
        'Mini Masters 4p-4:45p': (time(16, 0), time(16, 45)),
        'Swim L1/2 3p-3:30p': (time(15, 0), time(15, 30)),
        'Swim L3 3:30p-4p': (time(15, 30), time(16, 0)),
        'Swim T 3:30p-4:30p': (time(15, 30), time(16, 30)),
        'Tinker Titans 3:15p-4p': (time(15, 15), time(16, 0)),
        'Bball 3:15p-4p': (time(15, 15), time(16, 0)),
    }
    for name, expected in real.items():
        check(f'{name!r} parses', parse_class_times(name), expected)

    # ── Shapes the same office will type next ──────────────────────────────
    check('spaces around the dash are fine',
          parse_class_times('Bball 3:15p - 4p'), (time(15, 15), time(16, 0)))
    check('an en dash is fine',
          parse_class_times('Swim T 3:30p–4:30p'), (time(15, 30), time(16, 30)))
    check('an em dash is fine',
          parse_class_times('Swim T 3:30p—4:30p'), (time(15, 30), time(16, 30)))
    check('a full pm is fine',
          parse_class_times('Chess 3:00pm-3:45pm'), (time(15, 0), time(15, 45)))
    check('dotted meridiem is fine',
          parse_class_times('Chess 3:00 p.m.-3:45 p.m.'), (time(15, 0), time(15, 45)))
    check('CAPITALS are fine',
          parse_class_times('CRAFTING 4P-4:45P'), (time(16, 0), time(16, 45)))
    check('written-out minutes need no marker at all',
          parse_class_times('Chess 3:00-3:45'), (time(15, 0), time(15, 45)))
    check('a marker on one side carries to the other',
          parse_class_times('Chess 3-4p'), (time(15, 0), time(16, 0)))
    check('and in the other direction',
          parse_class_times('Chess 3p-4'), (time(15, 0), time(16, 0)))

    # ── The refusals, which are the point ─────────────────────────────────
    check('a class with no hours in its name', parse_class_times('Chess'), None)
    check('NO CLASS', parse_class_times('NO CLASS'), None)
    # The one that would break a naive parser: a slash date, not a range.
    check('NO CLASS with a date', parse_class_times('NO CLASS 6/15'), None)
    check('an empty name', parse_class_times(''), None)
    check('a name that is None', parse_class_times(None), None)

    # A BARE RANGE IS NOT A TIME. "L1-2" is a swim level, "K-4" is a grade
    # range, "1-2" is a lane. Reading any of them as 1pm-2pm would put a class
    # before the program starts, and the window check is not the only reason to
    # say no: there is no evidence in the string that it was ever a clock.
    check('a bare level range is not a time', parse_class_times('Swim L1-2'), None)
    check('a bare grade range is not a time', parse_class_times('Care K-4'), None)

    # But a real range later in the string still wins over an earlier decoy.
    check('the hours win over a level that looks like a range',
          parse_class_times('Swim L1-2 3:30p-4p'), (time(15, 30), time(16, 0)))

    # ── Implausible results are refused, not clamped ──────────────────────
    check('a backwards range', parse_class_times('Chess 4p-3p'), None)
    check('a zero-length range', parse_class_times('Chess 4p-4p'), None)
    check('a morning class in an after-school program',
          parse_class_times('Chess 9:00am-9:45am'), None)
    check('an evening class past the last dismissal',
          parse_class_times('Chess 8:30p-9:15p'), None)
    check('an hour that is not an hour', parse_class_times('Chess 25p-26p'), None)
    check('minutes that are not minutes', parse_class_times('Chess 3:99p-4:99p'), None)

    # ── The constants the rest of the engine will lean on ──────────────────
    check('there are exactly three blocks', TIME_BLOCKS, ('3-4', '4-5', '5-6'))
    check('the blocks tile 3pm to 6pm with no gap',
          [BLOCK_BOUNDS[b] for b in TIME_BLOCKS],
          [(time(15, 0), time(16, 0)), (time(16, 0), time(17, 0)),
           (time(17, 0), time(18, 0))])
    check('the four dismissal hours of R1',
          sorted(DISMISSAL_TIMES), [3, 4, 5, 6])
    # NULL means "no dismissal time", and the engine must never read it as 6.
    check('there is no entry for a missing dismissal time',
          None in DISMISSAL_TIMES, False)

    # ── How a grade is spelled ─────────────────────────────────────────────
    # grade_num 0 is kindergarten, and every sheet writes it 'K'. A screen
    # showing "0-4" would be showing a grade that does not exist.
    check('kindergarten is K, not 0', grade_label(0), 'K')
    check('a numbered grade is its number', grade_label(3), '3')
    check('a one-grade range is one label', grade_range_label(0, 0), 'K')
    check('K through 1 spans from K', grade_range_label(0, 1), 'K-1')
    check('the photo says 1-4', grade_range_label(1, 4), '1-4')

    # ── The photo's headers, rebuilt from the rules ─────────────────────────
    # This is the check that matters: load the five rules the sheet's headers
    # describe and the headers have to come back out, with the same labels.
    blocks = care_blocks(PHOTO_RULES, 'Monday', PHOTO_GRADES)
    check('every block is accounted for',
          [b['time_block'] for b in blocks], list(TIME_BLOCKS))
    check('3p-4p is Ocean (K) and Gym (1-4)',
          [(s['room_id'], s['grade_label']) for s in blocks[0]['segments']],
          [(OCEAN, 'K'), (GYM, '1-4')])
    check('4p-5p is Ocean (K-1) and Gym (2-4)',
          [(s['room_id'], s['grade_label']) for s in blocks[1]['segments']],
          [(OCEAN, 'K-1'), (GYM, '2-4')])
    check('5p-6p is Ocean (K-4), one room',
          [(s['room_id'], s['grade_label']) for s in blocks[2]['segments']],
          [(OCEAN, 'K-4')])
    check('the photo leaves no grade without a room',
          [b['uncovered'] for b in blocks], [[], [], []])

    # ── A grade with no rule is reported, never absorbed ────────────────────
    # A JCC with a fifth grade and rules that stop at 4. The fifth grader has
    # nowhere to be, and the only wrong answer is to put them in the room next
    # door without saying so.
    with_fifth = care_blocks(PHOTO_RULES, 'Monday', [0, 1, 2, 3, 4, 5])
    check('the uncovered grade is named',
          [b['uncovered'] for b in with_fifth], [[5], [5], [5]])
    check('and it is not folded into the last room',
          [(s['room_id'], s['grade_label']) for s in with_fifth[2]['segments']],
          [(OCEAN, 'K-4')])
    check('a grade with no rule resolves to nothing',
          resolve_care_room(PHOTO_RULES, 'Monday', '5-6', 5), None)

    # ── A gap in the middle does not merge across itself ────────────────────
    # K and 2 in Ocean, nothing for grade 1. Collapsing that into "Ocean (K-2)"
    # would claim a room for the one child who has no rule.
    gapped = care_blocks(
        [rule(1, '3-4', 0, 0, OCEAN), rule(2, '3-4', 2, 2, OCEAN)],
        'Monday', [0, 1, 2])
    check('a gap splits the run instead of spanning it',
          [(s['room_id'], s['grade_label']) for s in gapped[0]['segments']],
          [(OCEAN, 'K'), (OCEAN, '2')])
    check('and the grade in the gap is reported',
          gapped[0]['uncovered'], [1])

    # ── The precedence, one step at a time ─────────────────────────────────
    # 1. the day-specific rule beats the every-weekday rule
    week_and_day = [
        rule(1, '3-4', 0, 4, OCEAN),
        rule(2, '3-4', 0, 4, GYM, day='Wednesday'),
    ]
    check("Wednesday's own rule wins on Wednesday",
          resolve_care_room(week_and_day, 'Wednesday', '3-4', 0)['room_id'], GYM)
    check('and the standard week is untouched on Monday',
          resolve_care_room(week_and_day, 'Monday', '3-4', 0)['room_id'], OCEAN)

    # 2. then the narrower range — even when the wide one is a day rule and the
    #    narrow one is not, the day rule still wins. Step 1 comes first.
    check('a wide day rule still beats a narrow week rule',
          resolve_care_room(
              [rule(1, '3-4', 0, 0, OCEAN),
               rule(2, '3-4', 0, 4, GYM, day='Monday')],
              'Monday', '3-4', 0)['room_id'], GYM)
    check('among week rules, the narrower range wins',
          resolve_care_room(
              [rule(1, '3-4', 0, 4, GYM), rule(2, '3-4', 0, 0, OCEAN)],
              'Monday', '3-4', 0)['room_id'], OCEAN)

    # 3. then the lower priority
    check('the lower priority wins a tie',
          resolve_care_room(
              [rule(1, '3-4', 0, 4, GYM, priority=50),
               rule(2, '3-4', 0, 4, OCEAN, priority=10)],
              'Monday', '3-4', 0)['room_id'], OCEAN)

    # 4. and finally the lower id. Nothing stops two identical rows existing —
    #    the table has no unique — and without this the same afternoon would
    #    resolve to a different room depending on what Postgres returned first.
    twins = [rule(7, '3-4', 0, 4, GYM), rule(3, '3-4', 0, 4, OCEAN)]
    check('two identical rules resolve to the lower id',
          resolve_care_room(twins, 'Monday', '3-4', 0)['id'], 3)
    check('and the order they arrive in does not change that',
          resolve_care_room(list(reversed(twins)), 'Monday', '3-4', 0)['id'], 3)

    # An overlap the screen has to be able to show, rather than leave an admin
    # to discover by being surprised.
    check('an overlap reports every rule that matched',
          [r['id'] for r in care_candidates(week_and_day, 'Wednesday', '3-4', 0)],
          [2, 1])
    check('a block with no overlap reports one',
          len(care_candidates(PHOTO_RULES, 'Monday', '3-4', 0)), 1)

    # ── A rule for another block or another day is not a match ─────────────
    check('a rule in another block does not leak',
          resolve_care_room(PHOTO_RULES, 'Monday', '3-4', 0)['id'], 1)
    check('a Tuesday-only rule is silent on Monday',
          resolve_care_room([rule(1, '3-4', 0, 4, OCEAN, day='Tuesday')],
                            'Monday', '3-4', 0), None)

    # ── Which block a moment belongs to, and the boundary that decides ─────
    # Half-open: 4:00pm starts '4-5'. A class letting out at 4:00 sends its
    # children into the 4-5 block, and it is that block's care room they need —
    # reading 4:00 as the end of '3-4' would look up the wrong room.
    check('3pm opens the first block', block_of(at('15:00')), '3-4')
    check('3:59 is still the first block', block_of(at('15:59')), '3-4')
    check('4pm STARTS the second block, not ends the first',
          block_of(at('16:00')), '4-5')
    check('5pm starts the third', block_of(at('17:00')), '5-6')
    check('6pm is past the last block', block_of(at('18:00')), None)
    check('the morning is not a block', block_of(at('09:00')), None)
    check('no time is no block', block_of(None), None)

    # ── A missing dismissal time is never read as 6 ────────────────────────
    # R1's hours are 3, 4, 5 and 6. NULL means "this organization does not run
    # dismissal times"; defaulting it to the last hour would tell every other
    # JCC's parents to come at six.
    check('the four hours map to clocks',
          [dismissal_clock(h).strftime('%H:%M') for h in (3, 4, 5, 6)],
          ['15:00', '16:00', '17:00', '18:00'])
    check('NO DISMISSAL TIME STAYS NONE', dismissal_clock(None), None)
    check('and an hour outside R1 is not invented', dismissal_clock(7), None)

    # ── R3: chaining, and that it means EXACTLY adjacent ──────────────────
    check('a class starting when this one ends is the chain',
          next_chained_class([BBALL, CRAFTING], BBALL)['id'], CRAFTING['id'])
    check('the chain is directional',
          next_chained_class([BBALL, CRAFTING], CRAFTING), None)
    check('a class the child is not in cannot be the chain',
          next_chained_class([BBALL], BBALL), None)
    # A ten-minute gap is a child who has to be somewhere in between, and that
    # somewhere is care. Calling it a chain would leave the gap unstaffed.
    late = klass(9, 'Late Start', '16:10', '16:45')
    check('a gap is not a chain', next_chained_class([BBALL, late], BBALL), None)
    check('a class with no end has no chain',
          next_chained_class([CHESS, CRAFTING], CHESS), None)

    # ── R2: the three branches, in the order the spec states them ─────────
    # 1. the chain wins first — even against a dismissal time that matches.
    #    Contradictory data, but the spec's derived logic is explicit about the
    #    order, and a child with another class is in the building either way.
    dest, notes = dismiss_to([BBALL, CRAFTING], BBALL, 4, room(OCEAN))
    check('a chained class beats PARENTS at the same hour',
          (dest['kind'], dest['class_id']), (DEST_CLASS, CRAFTING['id']))
    check('and it needs no warning to do it', notes, [])

    # 2. PARENTS when the class ends exactly at the pickup hour.
    dest, notes = dismiss_to([TINKER], TINKER, 4, room(OCEAN))
    check('a class ending at the pickup hour goes to PARENTS',
          (dest['kind'], dest['label']), (DEST_PARENTS, 'PARENTS'))
    check('with nothing to warn about', notes, [])

    # 3. else the care room for the block the class ends in.
    dest, notes = dismiss_to([TINKER], TINKER, 5, room(OCEAN))
    check('a class ending before pickup goes to care',
          (dest['kind'], dest['room_id'], dest['label']),
          (DEST_CARE, OCEAN, 'Ocean Room'))
    check('quietly, because that is the normal case', notes, [])

    # ── The four warnings, none of which has a fallback ───────────────────
    # A class with no end time: nothing downstream is computable from it.
    dest, notes = dismiss_to([CHESS], CHESS, 5, room(OCEAN))
    check('a class with no end time has no destination',
          dest['kind'], DEST_UNKNOWN)
    check('and says which class needs its hours',
          [n['code'] for n in notes], [W_CLASS_NO_END])

    # No dismissal time: R2 cannot tell PARENTS from care without it.
    dest, notes = dismiss_to([TINKER], TINKER, None, room(OCEAN))
    check('NO PICKUP TIME MEANS NO DESTINATION, NOT SIX O\'CLOCK',
          dest['kind'], DEST_UNKNOWN)
    check('and it names the missing pickup time',
          [n['code'] for n in notes], [W_NO_DISMISSAL])

    # A class ending after the child goes home. Heather confirmed this cannot
    # happen; the June workbook does it four times. Data error, not a branch.
    dest, notes = dismiss_to([CRAFTING], CRAFTING, 4, room(OCEAN))
    check('a class ending after pickup hands the child to the parent',
          dest['kind'], DEST_PARENTS)
    check('AND NEVER QUIETLY TO CARE',
          [n['code'] for n in notes], [W_CLASS_AFTER_DISMISSAL])

    # No care rule covers the grade in that block.
    dest, notes = dismiss_to([TINKER], TINKER, 5, None)
    check('no care room means no destination', dest['kind'], DEST_UNKNOWN)
    check('and says so rather than picking a room',
          [n['code'] for n in notes], [W_NO_CARE_ROOM])

    # ── The Care sheet's BOLD, which nobody types ──────────────────────────
    # Its legend: "BOLD = will only be there for part of the time due to the
    # class they are in". Both of these are off the photo.
    beau = care_segments([SWIM], 4)          # K, swims 3:00-3:30, home at 4
    check('a child pulled out by a class is in the block they share',
          [s['time_block'] for s in beau], ['3-4'])
    check('AND IS BOLD THERE', [s['partial'] for s in beau], [True])
    check('their From/To names the class they came out of',
          [(s['from_class'] or {}).get('name') for s in beau],
          ['Swim L1/2 3p-3:30p'])

    grant = care_segments([MINI], 5)         # K, class 4:00-4:45, home at 5
    check('a child whose class is in the NEXT block is in this one all hour',
          [s['time_block'] for s in grant], ['3-4', '4-5'])
    check('SO 3-4 IS NOT BOLD, AND 4-5 IS',
          [s['partial'] for s in grant], [False, True])
    check('and 3-4 says which class they are going TO',
          [(s['to_class'] or {}).get('name') for s in grant],
          ['Mini Masters 4p-4:45p', None])

    # In class for the whole hour: the block is absent, not present-and-empty.
    full = klass(10, 'All Hour', '16:00', '17:00')
    check('a class covering a whole block removes it',
          [s['time_block'] for s in care_segments([full], 6)], ['3-4', '5-6'])

    # A class in the middle of a block leaves two pieces. The child is there for
    # part of the hour, so bold, even though the block's edges are both theirs.
    middle = klass(11, 'Middle', '15:15', '15:45')
    mid = care_segments([middle], 4)
    check('a class inside a block still counts as part-time',
          [(s['time_block'], s['partial']) for s in mid], [('3-4', True)])

    # Going home ends the day. R1's hours are the block boundaries, so this only
    # ever drops whole blocks — never marks one bold.
    check('a 3pm pickup means no care at all', care_segments([], 3), [])
    home_at_four = care_segments([], 4)
    check('a 4pm pickup is one full block, not a bold one',
          [(s['time_block'], s['partial']) for s in home_at_four],
          [('3-4', False)])
    check('a 6pm pickup is all three', len(care_segments([], 6)), 3)
    check('no pickup time still places them, so nobody vanishes',
          [s['time_block'] for s in care_segments([], None)],
          list(TIME_BLOCKS))

    # ── A whole Monday, both sheets, from one pass ─────────────────────────
    kids = [
        # K, swims 3:00-3:30, home at 4. Care 3-4 in Ocean, bold.
        {'id': 1, 'name': 'Beau Farden', 'grade_num': 0, 'dismissal_time': 4},
        # K, Mini Masters 4:00-4:45, home at 5.
        {'id': 2, 'name': 'Grant Hoskins', 'grade_num': 0, 'dismissal_time': 5},
        # 2nd grade, Bball chained into Crafting, home at 6.
        {'id': 3, 'name': 'Cara Diaz', 'grade_num': 2, 'dismissal_time': 6},
        # 3rd grade, Tinker Titans ends exactly at their 4pm pickup.
        {'id': 4, 'name': 'Dan Ebner', 'grade_num': 3, 'dismissal_time': 4},
    ]
    signups = [
        {'child_id': 1, 'class_session_id': SWIM['id']},
        {'child_id': 2, 'class_session_id': MINI['id']},
        {'child_id': 3, 'class_session_id': BBALL['id']},
        {'child_id': 3, 'class_session_id': CRAFTING['id']},
        {'child_id': 4, 'class_session_id': TINKER['id']},
    ]
    day = plan_day(kids, MONDAY_CLASSES, signups, PHOTO_RULES, 'Monday', ROOMS)

    def dismissals(class_name):
        session = next(c for c in day['classes'] if c['name'] == class_name)
        return [(r['child_name'], r['dismiss_to']['label'])
                for r in session['children']]

    check('Swim sends its K home via the Ocean Room',
          dismissals('Swim L1/2 3p-3:30p'), [('Beau Farden', 'Ocean Room')])
    check('Bball chains into Crafting, by name',
          dismissals('Bball 3:15p-4p'), [('Cara Diaz', 'Crafting 4p-4:45p')])
    check('Crafting then sends her to the Gym, her grade\'s 4-5 room',
          dismissals('Crafting 4p-4:45p'), [('Cara Diaz', 'Gym')])
    check('Mini Masters ends before five, so Ocean again',
          dismissals('Mini Masters 4p-4:45p'), [('Grant Hoskins', 'Ocean Room')])
    check('AND TINKER TITANS HANDS ITS CHILD STRAIGHT TO THE PARENT',
          dismissals('Tinker Titans 3:15p-4p'), [('Dan Ebner', 'PARENTS')])
    check('the chained child is the one flagged as chained',
          [(r['child_name'], r['chained'])
           for c in day['classes'] for r in c['children'] if r['chained']],
          [('Cara Diaz', True)])
    check('a class with no hours and nobody in it still lists',
          [c['name'] for c in day['classes'] if not c['children']], ['Chess'])

    # The Care sheet: every block, its room, and who is in it.
    check('the care sheet is grouped by block and room',
          [(b['time_block'], b['room_name'],
            [(r['child_name'], r['partial']) for r in b['children']])
           for b in day['care']],
          [('3-4', 'Ocean Room', [('Beau Farden', True),
                                  ('Grant Hoskins', False)]),
           ('3-4', 'Gym', [('Cara Diaz', True), ('Dan Ebner', True)]),
           ('4-5', 'Ocean Room', [('Grant Hoskins', True)]),
           ('4-5', 'Gym', [('Cara Diaz', True)]),
           ('5-6', 'Ocean Room', [('Cara Diaz', False)])])
    check('the From/To column carries both directions',
          [(r['child_name'], r['from_class'], r['to_class'])
           for b in day['care'] if b['time_block'] == '3-4'
           for r in b['children']],
          [('Beau Farden', 'Swim L1/2 3p-3:30p', None),
           ('Grant Hoskins', None, 'Mini Masters 4p-4:45p'),
           ('Cara Diaz', None, 'Bball 3:15p-4p'),
           ('Dan Ebner', None, 'Tinker Titans 3:15p-4p')])
    check('a clean Monday produces no warnings', day['warnings'], [])

    # ── The same Monday with the data errors the workbook really has ──────
    broken_kids = [
        {'id': 5, 'name': 'No Pickup', 'grade_num': 0, 'dismissal_time': None},
        {'id': 6, 'name': 'No Grade', 'grade_num': None, 'dismissal_time': 5},
        {'id': 7, 'name': 'Late Class', 'grade_num': 0, 'dismissal_time': 4},
        {'id': 8, 'name': 'Two At Once', 'grade_num': 2, 'dismissal_time': 6},
    ]
    broken_signups = [
        {'child_id': 5, 'class_session_id': TINKER['id']},
        {'child_id': 6, 'class_session_id': TINKER['id']},
        {'child_id': 7, 'class_session_id': CRAFTING['id']},
        {'child_id': 8, 'class_session_id': BBALL['id']},
        {'child_id': 8, 'class_session_id': TINKER['id']},
    ]
    bad = plan_day(broken_kids, MONDAY_CLASSES, broken_signups, PHOTO_RULES,
                   'Monday', ROOMS)
    codes = {(w['child_name'], w['code']) for w in bad['warnings']}
    check('the child with no pickup time is reported',
          ('No Pickup', W_NO_DISMISSAL) in codes, True)
    check('the child with no grade is reported',
          ('No Grade', W_NO_GRADE) in codes, True)
    check('the class that ends after pickup is reported',
          ('Late Class', W_CLASS_AFTER_DISMISSAL) in codes, True)
    check('and two classes at the same hour are reported',
          ('Two At Once', W_CLASS_OVERLAP) in codes, True)
    # The missing grade IS the reason there is no room, so it is said once
    # rather than repeated per block — otherwise one bad record drowns out the
    # blocks that are genuinely missing a rule.
    check('the ungraded child is not also warned once per block',
          sorted(w['code'] for w in bad['warnings']
                 if w['child_name'] == 'No Grade'), [W_NO_GRADE])
    check('the child with no pickup time still has no invented destination',
          [r['dismiss_to']['kind'] for c in bad['classes']
           for r in c['children'] if r['child_name'] == 'No Pickup'],
          [DEST_UNKNOWN])
    # Two blocks, not three: they go home at five, so 5-6 is not theirs. Both
    # of the ones they are in have no room, because rules match on grade alone.
    check('and the ungraded child is not placed in a care room',
          [b['room_name'] for b in bad['care']
           for r in b['children'] if r['child_name'] == 'No Grade'],
          [None, None])

    # ── One person's shifts: what a clash is, and what it is not ──────────
    # The whole difficulty is that sharing a time BLOCK is not sharing time.
    # Two consecutive swim lessons are one person's ordinary hour; a class run
    # from inside a care room is a room with nobody in it.
    check('a care room shift spans its whole block',
          assignment_span(covers('Ocean Room', '4-5')), BLOCK_BOUNDS['4-5'])
    check('a class shift spans its own hours, not its block',
          assignment_span(SWIM_L), (at('15:00'), at('15:30')))
    check('a class with no end time has no span to compare',
          assignment_span(teaches('Chess', '15:15', None)), None)
    check('and neither has one with no start time',
          assignment_span(teaches('Chess', None, None)), None)

    check('two consecutive lessons in one block are not a clash',
          staff_overlaps([SWIM_L, SWIM_T]), [])
    # Reported earliest first, and by name where two shifts start together, so
    # the same schedule always names the same pair in the same order.
    check('but running a class from inside a care room is',
          [[a['label'], b['label']] for a, b in
           staff_overlaps([covers('Gym', '3-4'), SWIM_L])],
          [['Swim L1/2 3p-3:30p', 'Gym']])
    check('and so are two care rooms in the same hour',
          [[a['label'], b['label']] for a, b in
           staff_overlaps([covers('Ocean Room', '4-5'), covers('Gym', '4-5')])],
          [['Gym', 'Ocean Room']])
    check('a class ending as the next block starts does not clash with it',
          staff_overlaps([teaches('Bball 3:15p-4p', '15:15', '16:00'),
                          covers('Gym', '4-5')]), [])
    # A shift with no hours is left out rather than widened to its block: the
    # guess is what would report Lillian's two lessons as a clash.
    check('a class with no hours is never reported as clashing',
          staff_overlaps([teaches('Chess', None, None), covers('Gym', '3-4')]),
          [])

    # ── The hours nobody gave somebody who is already here ────────────────
    check('a class covers the block its hours start in',
          sorted(covered_blocks([teaches('Bball 3:15p-4p', '15:15', '16:00')])),
          ['3-4'])
    check('and both blocks when it runs across the boundary',
          sorted(covered_blocks([teaches('Swim T 3:30p-4:30p',
                                         '15:30', '16:30')])),
          ['3-4', '4-5'])
    check('a hole between two covered blocks is reported',
          staff_gaps([covers('Gym', '3-4'), covers('Ocean Room', '5-6')]),
          ['4-5'])
    # The edges have to stay quiet: leaving at five is the commonest shift on
    # the sheet, and an app that flags it flags most of the staff.
    check('but going home after 4-5 is not a hole',
          staff_gaps([covers('Gym', '3-4'), covers('Gym', '4-5')]), [])
    check('nor is arriving in time for 4-5',
          staff_gaps([covers('Gym', '4-5'), covers('Gym', '5-6')]), [])
    check('one block on its own is never a hole',
          staff_gaps([covers('Gym', '4-5')]), [])
    check('and neither is a day with nothing on it',
          staff_gaps([]), [])
    check('the swim pair covers 3-4 once, and leaves no hole behind it',
          (sorted(covered_blocks([SWIM_L, SWIM_T])), staff_gaps([SWIM_L,
                                                                 SWIM_T])),
          (['3-4'], []))

    # ── Purity ────────────────────────────────────────────────────────────
    # The whole value of this module is that it can be exercised without a
    # database. An import of flask or psycopg2 would quietly end that.
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    source = open(os.path.join(here, 'server', 'daily_routing.py')).read()
    imports = [ln for ln in source.splitlines()
               if re.match(r'\s*(import|from)\s', ln)]
    check('the module imports nothing that needs a database or a request',
          [ln for ln in imports
           if re.search(r'flask|psycopg|database|\bapp\b|tenancy', ln)], [])

    print()
    if failures:
        print(f"{len(failures)} check(s) failed: {', '.join(failures)}")
        return 1
    print('All daily routing checks passed.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
