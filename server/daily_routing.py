"""Pure logic for one afternoon: where each child is, and who they go to.

Like `server/roster_import.py`, this module is deliberately pure. It takes plain
values and returns plain values — no database, no Flask, no request context, no
logging — so every rule it applies is reproducible from its inputs and testable
without a database (`tests/test_daily_routing.py`).

This is the module every daily view derives from:

    parse_class_times()  — read a class's hours out of its own name
    grade_label()        — 0 as 'K', the way the sheets write it
    care_candidates()    — every care rule matching a grade, best first
    resolve_care_room()  — which room a grade waits in, for a weekday and block
    care_blocks()        — the parenthesised header of the Care sheet, rebuilt
    dismiss_to()         — R2/R3: the next chained class, or PARENTS, or care
    care_segments()      — which care blocks a child appears in, and in bold
    assignment_span()    — the stretch of afternoon one staff shift occupies
    staff_overlaps()     — the shifts of one person that land on top of another
    staff_gaps()         — the hours nobody gave a person who is already here
    plan_day()           — both sheets for one weekday, from one pass

IT NEVER INVENTS A DESTINATION
    Every rule here would rather return None and a warning than a plausible
    guess. `Dismiss To` is the answer to "where is the parent standing", so a
    confident wrong one sends someone to the wrong end of the building at 4pm
    while an empty one with a warning attached sends an admin to fix the data.
    Four things produce warnings instead of answers, and none of them has a
    fallback: a missing dismissal time (NEVER read as 6), a class with no end
    time, a class that ends after the child goes home, and a grade no care rule
    covers.

THE THREE TIME BLOCKS ARE NOT A MODEL OF TIME
    '3-4', '4-5' and '5-6' are how this JCC talks about its afternoon, and they
    are CHECK-constrained in `care_assignment_rules` and everywhere downstream.
    A JCC on a different schedule needs a migration, not a config flag. And the
    spec's note that Friday collapses Classes and Care into one sheet is a
    presentation choice — do not model it here.
"""

from __future__ import annotations

import re
from datetime import time

WEEKDAYS = ('Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday')

TIME_BLOCKS = ('3-4', '4-5', '5-6')

BLOCK_BOUNDS: dict[str, tuple[time, time]] = {
    '3-4': (time(15, 0), time(16, 0)),
    '4-5': (time(16, 0), time(17, 0)),
    '5-6': (time(17, 0), time(18, 0)),
}

#: The four dismissal times of R1, as clock times. `registrations.dismissal_time`
#: stores the hour as a SMALLINT between 3 and 6, and NULL means "this
#: organization does not use dismissal times" — never 6.
DISMISSAL_TIMES: dict[int, time] = {
    3: time(15, 0), 4: time(16, 0), 5: time(17, 0), 6: time(18, 0),
}

#: The window a parsed time has to land in to be believable. The program runs
#: 3pm to 6pm; anything outside noon-to-8pm came from misreading a name, and a
#: rejected guess is worth far more than a confident wrong one.
_EARLIEST = time(12, 0)
_LATEST = time(20, 0)

# One side of a range: an hour, optional :minutes, optional am/pm marker.
_SIDE = r'(?P<{0}h>\d{{1,2}})(?::(?P<{0}m>\d{{2}}))?\s*(?P<{0}p>[ap]\.?m?\.?)?'

# "3p-3:30p", "3:15p - 4p", "3:30p–4:30p", "3:00-3:45". The dash may be a
# hyphen, an en dash or an em dash: the roster is typed by hand in Excel, which
# autocorrects some of them.
_RANGE = re.compile(
    _SIDE.format('s') + r'\s*[-–—]\s*' + _SIDE.format('e'),
    re.IGNORECASE,
)


def _meridiem(marker: str | None) -> str | None:
    """'p' or 'a' from a marker like 'p', 'pm', 'P.M.', or None if absent."""
    if not marker:
        return None
    return marker[0].lower()


def _to_time(hour: int, minute: int, meridiem: str | None) -> time | None:
    """One side of a range as a clock time, or None if it cannot be one."""
    if not 1 <= hour <= 12 or not 0 <= minute <= 59:
        return None
    if meridiem == 'a':
        return time(0 if hour == 12 else hour, minute)
    # No marker on this side falls through to PM. Every hour this program runs
    # is afternoon, and the caller still has to pass the window check below.
    return time(hour if hour == 12 else hour + 12, minute)


def parse_class_times(name: str) -> tuple[time, time] | None:
    """The start and end hidden inside a class's own name, or None.

    The roster's M/T/W/R/F columns hold free text the office typed, and the
    hours are usually in it: `"Crafting 4p-4:45p"`, `"Swim L1/2 3p-3:30p"`,
    `"Tinker Titans 3:15p-4p"`. The importer stores that whole string as the
    class name and leaves `start_time` / `end_time` NULL, because a wrong
    `end_time` routes a child to a room their parent is not standing in.

    So this function exists to make a SUGGESTION an admin confirms. It must
    never be wired to write directly. Read the endpoint that uses it as the
    contract: it proposes, she accepts.

    It returns None rather than guessing whenever the name is not obviously a
    time range — `"Chess"`, `"NO CLASS"`, `"NO CLASS 6/15"` — and whenever the
    result would be implausible for an after-school program.
    """
    if not name:
        return None

    # Take the LAST range in the string. The hours sit at the end of these
    # names, and a leading token like "Swim L1-2" would otherwise win.
    match = None
    for match in _RANGE.finditer(str(name)):
        pass
    if match is None:
        return None

    g = match.groupdict()
    start_mark = _meridiem(g['sp'])
    end_mark = _meridiem(g['ep'])

    # A bare "1-2" is a level, a lane or a grade range far more often than it is
    # a time. Require some evidence: an am/pm marker, or minutes written out.
    if not (start_mark or end_mark or g['sm'] or g['em']):
        return None

    start = _to_time(int(g['sh']), int(g['sm'] or 0), start_mark or end_mark)
    end = _to_time(int(g['eh']), int(g['em'] or 0), end_mark or start_mark)
    if start is None or end is None:
        return None

    if not (_EARLIEST <= start < end <= _LATEST):
        return None
    return start, end


# ── Care rules: which room a grade waits in ────────────────────────────────
#
# `care_assignment_rules` holds (weekday or every-weekday) × block × grade range
# → room. Overlaps are legal ON PURPOSE, so a one-Wednesday exception can sit on
# top of the standard week without deleting the standard week. Which means
# something has to break the tie, and until now that something was a comment in
# `server/database.py` and a banner in `sql/29` — described, never implemented.
#
# It lives here, once. Two copies of this ordering would put two numbers on the
# same afternoon and neither screen would look wrong.


def grade_label(grade_num: int) -> str:
    """A grade the way the sheets write it: 0 is kindergarten, so 0 is 'K'.

    `children.grade_label` keeps whatever the roster typed ('K', '0', '3') and
    `children.grade_num` is what ranges compare against, with K and 0 both
    landing on 0. Rules only carry numbers, so this is how a number gets back to
    the spelling Heather reads.
    """
    return 'K' if grade_num == 0 else str(grade_num)


def grade_range_label(grade_min: int, grade_max: int) -> str:
    """'K', or 'K-1', or '1-4' — the text in parentheses on the Care sheet."""
    if grade_min == grade_max:
        return grade_label(grade_min)
    return f'{grade_label(grade_min)}-{grade_label(grade_max)}'


def _rule_rank(rule: dict) -> tuple[int, int, int, int]:
    """The documented precedence, as a sort key. Lower wins.

    1. a rule for THIS weekday beats the every-weekday rule
    2. then the narrower grade range — the specific exception over the sweep
    3. then the lower `priority`, matching how `rooms.sort_order` reads
    4. then the lower id

    The last one is not in the original description and is not decoration.
    Nothing stops two identical rules existing (the table has no unique), and
    without a total order Postgres is free to return them in either order — so
    the same day would resolve to a different room between two requests, and a
    headcount would move with nobody having changed anything.
    """
    return (
        0 if rule.get('day_of_week') else 1,
        int(rule['grade_max']) - int(rule['grade_min']),
        int(rule.get('priority') or 0),
        int(rule['id']),
    )


def care_candidates(
    rules: list[dict], day_of_week: str, time_block: str, grade_num: int,
) -> list[dict]:
    """Every rule that covers this grade in this block, best first.

    The caller gets the whole list, not just the winner, because a screen that
    only shows the winner leaves an admin to discover the precedence by being
    surprised by it. len() > 1 is an overlap worth showing.
    """
    matching = [
        rule for rule in rules
        if rule['time_block'] == time_block
        and rule.get('day_of_week') in (None, day_of_week)
        and int(rule['grade_min']) <= grade_num <= int(rule['grade_max'])
    ]
    return sorted(matching, key=_rule_rank)


def resolve_care_room(
    rules: list[dict], day_of_week: str, time_block: str, grade_num: int,
) -> dict | None:
    """The one rule that decides where this grade waits, or None if none does.

    None is a real answer and the caller has to carry it: it means a child in
    this grade has nowhere to be in this block, which is a child with no
    computable destination rather than a gap in a settings page.
    """
    candidates = care_candidates(rules, day_of_week, time_block, grade_num)
    return candidates[0] if candidates else None


def care_blocks(
    rules: list[dict], day_of_week: str, grades: list[int],
) -> list[dict]:
    """Rebuild the Care sheet's block headers for one weekday.

    The photo reads `3p-4p ... Ocean Room (K)` and `Gym (1-4)`. Those labels are
    not stored anywhere — they are what the resolved rules add up to — so they
    are derived here, from the same resolution the routing engine uses. If this
    disagreed with `resolve_care_room`, the header would advertise a room the
    engine does not send anyone to.

    `grades` is the grades that actually exist in the roster, so a JCC with a
    fifth grade gets a fifth column instead of an invisible hole. Adjacent
    grades resolving to the same room collapse into one range, which is how
    `K, 1 → Ocean` becomes `Ocean Room (K-1)`. A room reached by two
    non-adjacent runs of grades stays two segments, because that is the truth.

    `uncovered` is every grade with no rule in the block — the warning of §6.3,
    reported per block rather than summed away.
    """
    ordered = sorted(set(grades))
    blocks = []
    for block in TIME_BLOCKS:
        resolved = [
            (grade, resolve_care_room(rules, day_of_week, block, grade))
            for grade in ordered
        ]
        segments: list[dict] = []
        for grade, winner in resolved:
            if winner is None:
                continue
            last = segments[-1] if segments else None
            # Extend the run only when it is the same room AND the grade is the
            # next one along. A gap in between is a different segment: merging
            # across it would claim a room for a grade that has no rule.
            if (last and last['room_id'] == winner['room_id']
                    and last['grade_max'] == grade - 1):
                last['grade_max'] = grade
                last['grades'].append(grade)
                last['rule_ids'].append(winner['id'])
            else:
                segments.append({
                    'room_id': winner['room_id'],
                    'grade_min': grade,
                    'grade_max': grade,
                    'grades': [grade],
                    'rule_ids': [winner['id']],
                })
        for segment in segments:
            segment['grade_label'] = grade_range_label(
                segment['grade_min'], segment['grade_max'])
        blocks.append({
            'time_block': block,
            'segments': segments,
            'uncovered': [g for g, winner in resolved if winner is None],
        })
    return blocks


# ── The routing engine — R2/R3 ─────────────────────────────────────────────
#
# `Dismiss To` on the Classes sheet, and `From/To Class` on the Care sheet. The
# spec calls R2 "the most important rule in the app" and states it as two
# branches; with R3's chaining in front, the engine has three:
#
#     1. the next chained class, if one starts exactly when this one ends
#     2. else PARENTS, when the class ends at the child's dismissal time
#     3. else the care room for (grade, block)
#
# There is deliberately no fourth. Heather confirmed on 2026-08-04 that a class
# never ends AFTER the child goes home, so a session that does is a data error —
# it dismisses to PARENTS with a warning, never quietly to care, because care
# would leave a child in a room the parent is not standing in.

#: What a destination can be. 'unknown' is a real outcome, not a failure to
#: compute one: it always travels with a warning naming what is missing.
DEST_CLASS = 'class'
DEST_PARENTS = 'parents'
DEST_CARE = 'care'
DEST_UNKNOWN = 'unknown'

#: Warning codes. §6.3 asks the admin board to show "child with no computable
#: destination"; these say which kind, because the fix differs for each.
W_NO_DISMISSAL = 'no_dismissal_time'
W_CLASS_NO_END = 'class_without_end_time'
W_CLASS_AFTER_DISMISSAL = 'class_ends_after_dismissal'
W_NO_CARE_ROOM = 'no_care_room_for_grade'
W_NO_GRADE = 'child_without_grade'
W_CLASS_OVERLAP = 'classes_overlap'

#: The two about an adult rather than a child. Both are advice, not refusals:
#: the first says one person is in two places at once, the second that somebody
#: already in the building has an hour nobody gave them.
W_STAFF_OVERLAP = 'staff_overlap'
W_STAFF_GAP = 'staff_gap'

#: The earliest a child can be in the building, for interval arithmetic. The
#: program's own 3pm; a class starting before it would already have been
#: rejected by parse_class_times' window.
DAY_START = time(15, 0)


def block_of(moment: time | None) -> str | None:
    """The block a clock time falls in, or None if it is outside 3pm-6pm.

    Half-open, so 4:00pm starts '4-5' rather than ending '3-4'. A class letting
    out at 4:00 sends its children into the 4-5 block, and that is the block
    whose care room they need.
    """
    if moment is None:
        return None
    for block in TIME_BLOCKS:
        start, end = BLOCK_BOUNDS[block]
        if start <= moment < end:
            return block
    return None


def dismissal_clock(hour: int | None) -> time | None:
    """A `registrations.dismissal_time` hour as a clock time, or None.

    NULL means "this organization does not use dismissal times" and must never
    be read as 6 — R1's four hours are 3, 4, 5 and 6, and defaulting to the last
    one would tell every other JCC's parents to come at six.
    """
    if hour is None:
        return None
    return DISMISSAL_TIMES.get(int(hour))


def _overlap(a: tuple[time, time], b: tuple[time, time]) -> bool:
    """Do two half-open intervals share any time at all?"""
    return a[0] < b[1] and b[0] < a[1]


def _subtract(base: tuple[time, time],
              cuts: list[tuple[time, time]]) -> list[tuple[time, time]]:
    """`base` minus every interval in `cuts`, as the pieces that survive.

    Half-open throughout: a class ending at 4:00 and a block starting at 4:00 do
    not overlap, which is the whole reason a child leaving a 3:15-4:00 class
    belongs to the 4-5 block and not to both.
    """
    pieces = [base]
    for cut in sorted(cuts):
        remaining = []
        for start, end in pieces:
            if not _overlap((start, end), cut):
                remaining.append((start, end))
                continue
            if start < cut[0]:
                remaining.append((start, cut[0]))
            if cut[1] < end:
                remaining.append((cut[1], end))
        pieces = remaining
    return pieces


def _timed(classes: list[dict]) -> list[dict]:
    """Only the classes with both hours filled in, earliest first."""
    return sorted(
        (c for c in classes if c.get('start_time') and c.get('end_time')),
        key=lambda c: (c['start_time'], c['end_time']),
    )


def next_chained_class(classes: list[dict], leaving: dict) -> dict | None:
    """R3: the class that starts exactly when `leaving` ends, if there is one.

    Exactly, not "soon after". The sheets chain 3:15-4:00 into 4:00-4:45, and a
    gap of even ten minutes is a child who has to be somewhere in between — which
    is care, and saying otherwise would leave that gap unstaffed.
    """
    end = leaving.get('end_time')
    if not end:
        return None
    for candidate in _timed(classes):
        if candidate['id'] != leaving['id'] and candidate['start_time'] == end:
            return candidate
    return None


def dismiss_to(
    classes: list[dict],
    leaving: dict,
    dismissal_hour: int | None,
    care_room: dict | None,
) -> tuple[dict, list[dict]]:
    """Where a child goes when `leaving` lets out. Returns (destination, warnings).

    `classes` is every class this child has that weekday, so chaining can be
    seen. `care_room` is the already-resolved rule for the block the class ends
    in — resolving it here would mean this function needed the rules, the grade
    and the weekday, and the caller already has all three.

    The destination always has a `kind`; a 'unknown' one always comes with a
    warning saying which piece of data is missing.
    """
    warnings = []

    end = leaving.get('end_time')
    if not end:
        # The class catalogue has not been filled in for this one yet. Nothing
        # downstream can be computed from it, and inventing an end time is
        # exactly what sql/35 refused to do.
        return ({'kind': DEST_UNKNOWN, 'label': None}, [{
            'code': W_CLASS_NO_END,
            'class_id': leaving['id'],
            'message': (f"\"{leaving.get('name')}\" has no end time, so there is "
                        "no way to know where its children go next."),
        }])

    chained = next_chained_class(classes, leaving)
    if chained:
        return ({'kind': DEST_CLASS, 'class_id': chained['id'],
                 'label': chained.get('name')}, warnings)

    home = dismissal_clock(dismissal_hour)
    if home is None:
        return ({'kind': DEST_UNKNOWN, 'label': None}, [{
            'code': W_NO_DISMISSAL,
            'class_id': leaving['id'],
            'message': ('No pickup time on file for this weekday, so R2 cannot '
                        'tell parents-at-the-class from a care room.'),
        }])

    if end == home:
        return ({'kind': DEST_PARENTS, 'label': 'PARENTS'}, warnings)

    if end > home:
        # R2 has no branch for this and Heather says it cannot happen. The June
        # workbook does it four times, so it is bad data: hand the child to the
        # parent who is already there, and say so loudly.
        return ({'kind': DEST_PARENTS, 'label': 'PARENTS'}, [{
            'code': W_CLASS_AFTER_DISMISSAL,
            'class_id': leaving['id'],
            'message': (f"\"{leaving.get('name')}\" ends at "
                        f"{end.strftime('%H:%M')}, after this child goes home at "
                        f"{home.strftime('%H:%M')}. Dismissing to PARENTS — check "
                        "the class hours or the pickup time."),
        }])

    if care_room is None:
        return ({'kind': DEST_UNKNOWN, 'label': None}, [{
            'code': W_NO_CARE_ROOM,
            'class_id': leaving['id'],
            'message': ('No care room covers this grade in the block this class '
                        'ends in, so this child has nowhere to wait.'),
        }])

    return ({'kind': DEST_CARE, 'room_id': care_room['room_id'],
             'label': care_room.get('room_name')}, warnings)


def care_segments(
    classes: list[dict], dismissal_hour: int | None,
) -> list[dict]:
    """Which care blocks a child is in, and for how much of each.

    A child is in block B for whatever of B is left after their classes and
    after they have gone home. Three fields come out of that:

      `partial`  — the Care sheet's BOLD, whose legend reads "will only be there
                   for part of the time due to the class they are in". It is not
                   a flag anyone types: it is true exactly when a class eats into
                   the block. Going home cannot cause it, because R1's dismissal
                   hours land on the same hour boundaries as the blocks.
      `from_class` / `to_class` — the Care sheet's `From/To Class` column: the
                   class whose ending opens this segment, and the one whose start
                   closes it. Either or both may be None, which the sheet writes
                   as `NO CLASS`.

    A block the child is in for none of the time is absent from the result, not
    present-and-empty: they are in class for the whole hour, or already home.
    """
    timed = _timed(classes)
    intervals = [(c['start_time'], c['end_time']) for c in timed]
    home = dismissal_clock(dismissal_hour)

    segments = []
    for block in TIME_BLOCKS:
        bounds = BLOCK_BOUNDS[block]
        # Present for whatever of the block is before they go home. With R1's
        # hours this only ever drops whole blocks — 3, 4, 5 and 6 are the block
        # boundaries — but clamping instead of assuming costs nothing.
        window = bounds if home is None else (bounds[0], min(bounds[1], home))
        if window[0] >= window[1]:
            continue

        free = _subtract(window, intervals)
        if not free:
            continue  # in class for the whole time they were here

        # The bold is measured against the BLOCK, and only against the classes:
        # its legend says "due to the class they are in", so going home early
        # must not set it even if that ever becomes possible.
        in_block = _subtract(bounds, intervals)
        segments.append({
            'time_block': block,
            'partial': in_block != [bounds],
            'from_class': next((c for c in timed
                                if c['end_time'] == free[0][0]), None),
            'to_class': next((c for c in timed
                              if c['start_time'] == free[-1][1]), None),
        })
    return segments


# ── The staff schedule, read one person at a time ───────────────────────────
#
# The three below answer the questions `M-Staff` answers on paper and the
# per-slot grid cannot: is anybody in two places at once, and did anybody end up
# with an hour nobody gave them. An assignment here is a dict with:
#
#     kind        — 'class' or 'room'
#     time_block  — rooms only; classes carry their own hours instead
#     start_time  — classes only; a `datetime.time` or None
#     end_time    — classes only; a `datetime.time` or None
#
# which is the same pair `staff_assignments` allows and the same one
# `block_checks` targets, so "the block I am standing in" keeps one spelling.


def assignment_span(entry: dict) -> tuple[time, time] | None:
    """The stretch of afternoon one shift occupies, or None if unknowable.

    A care room is staffed by the hour, so its span is the block's own bounds.
    A class carries its own hours, and when either is missing this returns None
    rather than falling back to the block the class starts in. That fallback
    would invent clashes: `Swim L1/2 3p-3:30p` and `Swim L3 3:30p-4p` are one
    person's two consecutive lessons, written on the sheet as the single cell
    `Swim L/T`, and widening either to the whole 3-4 hour makes them collide.
    """
    if entry.get('kind') == 'room':
        return BLOCK_BOUNDS.get(entry.get('time_block'))
    start, end = entry.get('start_time'), entry.get('end_time')
    if not start or not end:
        return None
    return (start, end)


def staff_overlaps(entries: list[dict]) -> list[tuple[dict, dict]]:
    """The pairs among ONE person's shifts that share any time at all.

    Sharing a time BLOCK is not sharing time — see `assignment_span`. What this
    catches is the real thing: running a class while also being the adult in a
    care room, or being down for two rooms in the same hour, which is a room
    that will have nobody in it at four o'clock.

    A shift with no computable span is left out entirely rather than guessed
    at. Earliest first, so the same schedule always reports the same pair in the
    same order.
    """
    timed = sorted(
        ((span, entry) for span, entry
         in ((assignment_span(e), e) for e in entries) if span),
        key=lambda pair: (pair[0], str(pair[1].get('label') or '')),
    )
    clashes = []
    for index, (span, entry) in enumerate(timed):
        for other_span, other in timed[index + 1:]:
            if _overlap(span, other_span):
                clashes.append((entry, other))
    return clashes


def covered_blocks(entries: list[dict]) -> set[str]:
    """The blocks this person is standing in for at least part of."""
    spans = [span for span in (assignment_span(e) for e in entries) if span]
    return {block for block in TIME_BLOCKS
            if any(_overlap(span, BLOCK_BOUNDS[block]) for span in spans)}


def staff_gaps(entries: list[dict]) -> list[str]:
    """Blocks with nothing in them BETWEEN two blocks that have something.

    Interior only, and the restriction is the whole point. An empty 5-6 is the
    person who works until five, and on `M-Staff` that is a blank cell rather
    than a mistake — nobody's contracted hours are recorded anywhere in this
    app, so warning at the edges would warn about most of the staff and the
    warning would stop being read. A hole in the middle is a different claim:
    they are in the building either side of it, so there is an hour that
    belongs to nobody.
    """
    covered = covered_blocks(entries)
    if len(covered) < 2:
        return []
    indexes = [TIME_BLOCKS.index(block) for block in covered]
    return [block for index, block in enumerate(TIME_BLOCKS)
            if min(indexes) < index < max(indexes) and block not in covered]


def plan_day(
    children: list[dict],
    classes: list[dict],
    enrollments: list[dict],
    rules: list[dict],
    day_of_week: str,
    rooms: dict[int, str] | None = None,
) -> dict:
    """Both sheets for one weekday, from one pass over the data.

    `children` carries `id`, `grade_num` and `dismissal_time` for THIS weekday
    (the caller joins `registrations`, because only it knows which weekday's row
    to take). `classes` is that weekday's catalogue; `enrollments` pairs
    child_id with class_session_id.

    Returns the Classes sheet (`classes`, each with its roster and every child's
    `Dismiss To`), the Care sheet (`care`, per block per room, with the bold
    already worked out) and every `warning` the two produced. One function
    rather than two so a counselor's day and the admin's board cannot disagree
    about the same afternoon.
    """
    rooms = rooms or {}
    by_id = {c['id']: c for c in classes}
    per_child: dict[int, list[dict]] = {}
    for row in enrollments:
        session = by_id.get(row['class_session_id'])
        if session:
            per_child.setdefault(row['child_id'], []).append(session)

    warnings: list[dict] = []

    def warn(child, entries):
        """Record warnings for a child, minus the ones a bigger one subsumes.

        A child with no grade cannot be matched by a care rule at all, so both
        sheets would report "no care room" for every block and every class they
        leave — the same cause, five or six times over, burying the rooms that
        are genuinely missing a rule. W_NO_GRADE is raised once instead.
        """
        ungraded = child.get('grade_num') is None
        for entry in entries:
            if ungraded and entry['code'] == W_NO_CARE_ROOM:
                continue
            warnings.append({**entry, 'child_id': child['id'],
                             'child_name': child.get('name')})

    def room_for(child, block):
        """The care room for this child in this block, as a dict or None."""
        if child.get('grade_num') is None:
            return None
        winner = resolve_care_room(rules, day_of_week, block, child['grade_num'])
        if not winner:
            return None
        return {**winner, 'room_name': rooms.get(winner['room_id'])}

    # ── The Classes sheet ────────────────────────────────────────────────
    class_rosters: dict[int, list[dict]] = {c['id']: [] for c in classes}
    for child in children:
        mine = per_child.get(child['id'], [])
        # R4 puts a child in several classes a day on purpose, but two that run
        # at the same time is one child in two rooms. It routes anyway — both
        # rows still get a destination — and says so.
        overlapping = _timed(mine)
        for earlier, later in zip(overlapping, overlapping[1:]):
            if _overlap((earlier['start_time'], earlier['end_time']),
                        (later['start_time'], later['end_time'])):
                warn(child, [{'code': W_CLASS_OVERLAP, 'message': (
                    f"\"{earlier.get('name')}\" and \"{later.get('name')}\" "
                    'overlap, so this child is booked into two places at once.'),
                }])
        for session in mine:
            block = block_of(session.get('end_time'))
            destination, notes = dismiss_to(
                mine, session, child.get('dismissal_time'),
                room_for(child, block) if block else None)
            warn(child, notes)
            class_rosters[session['id']].append({
                'child_id': child['id'],
                'child_name': child.get('name'),
                'grade_num': child.get('grade_num'),
                'grade_label': (None if child.get('grade_num') is None
                                else grade_label(child['grade_num'])),
                'dismissal_time': child.get('dismissal_time'),
                'dismiss_to': destination,
                # R3's own convention: she marks chained kids with `**`.
                'chained': destination['kind'] == DEST_CLASS,
            })

    # ── The Care sheet ───────────────────────────────────────────────────
    care: dict[tuple[str, int | None], list[dict]] = {}
    for child in children:
        mine = per_child.get(child['id'], [])
        if child.get('grade_num') is None:
            # Care rules match on grade alone, so no rule can reach this child.
            # `warn` drops the per-block "no care room" notes in favour of this
            # one, which is the actual fix.
            warn(child, [{'code': W_NO_GRADE, 'message': (
                'No grade on file, so no care rule can place this child.')}])
        for segment in care_segments(mine, child.get('dismissal_time')):
            room = room_for(child, segment['time_block'])
            if room is None:
                warn(child, [{'code': W_NO_CARE_ROOM,
                              'time_block': segment['time_block'],
                              'message': (
                                  'Nowhere to wait in the '
                                  f"{segment['time_block']} block.")}])
            key = (segment['time_block'], room['room_id'] if room else None)
            care.setdefault(key, []).append({
                'child_id': child['id'],
                'child_name': child.get('name'),
                'grade_num': child.get('grade_num'),
                'grade_label': (None if child.get('grade_num') is None
                                else grade_label(child['grade_num'])),
                'dismissal_time': child.get('dismissal_time'),
                'partial': segment['partial'],
                'from_class': (segment['from_class'] or {}).get('name'),
                'to_class': (segment['to_class'] or {}).get('name'),
            })

    return {
        'day_of_week': day_of_week,
        'classes': [
            {**session, 'children': sorted(
                class_rosters[session['id']],
                key=lambda r: (r['child_name'] or '').lower())}
            for session in _timed(classes) + [
                c for c in classes
                if not (c.get('start_time') and c.get('end_time'))]
        ],
        'care': [
            {'time_block': block, 'room_id': room_id,
             'room_name': rooms.get(room_id) if room_id else None,
             'children': sorted(
                 roster, key=lambda r: (r['child_name'] or '').lower())}
            for (block, room_id), roster in sorted(
                care.items(),
                key=lambda kv: (TIME_BLOCKS.index(kv[0][0]), kv[0][1] or 0))
        ],
        'warnings': warnings,
    }
