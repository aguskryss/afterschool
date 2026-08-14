import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CalendarClock,
  Plus,
  RotateCcw,
  TriangleAlert,
  UserRoundX,
  Users,
  X,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Card, EmptyState, Skeleton } from '@/components/ui'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const
type Weekday = (typeof WEEKDAYS)[number]

const BLOCKS = ['3-4', '4-5', '5-6'] as const
type TimeBlock = (typeof BLOCKS)[number]

const BLOCK_LABEL: Record<TimeBlock, string> = {
  '3-4': '3p – 4p',
  '4-5': '4p – 5p',
  '5-6': '5p – 6p',
}

/**
 * The hours each block covers, mirroring `daily_routing.BLOCK_BOUNDS`.
 *
 * Here only to answer "is this person already busy at this hour" while the
 * picker is open, which has to happen before anything is saved. The server
 * decides the same question again for the warnings, from the same bounds — this
 * is a hint, never the verdict. Zero-padded 24-hour strings compare correctly
 * with `<`, which is also why the API sends times in that shape.
 */
const BLOCK_SPAN: Record<TimeBlock, [string, string]> = {
  '3-4': ['15:00', '16:00'],
  '4-5': ['16:00', '17:00'],
  '5-6': ['17:00', '18:00'],
}

function overlaps(a: [string, string], b: [string, string]): boolean {
  return a[0] < b[1] && b[0] < a[1]
}

type Person = {
  assignment_id: number
  counselor_id: number
  counselor_name: string | null
  /** A dated override rather than part of the weekly pattern. */
  only_today: boolean
}

/** Somebody a "not today" row took out of this slot for the date being viewed. */
type StoodDown = {
  assignment_id: number
  counselor_id: number
  counselor_name: string | null
}

type ClassSlot = {
  id: number
  name: string
  start_time: string | null
  end_time: string | null
  location: string | null
  enrolled_count: number
  staff: Person[]
  out_today: StoodDown[]
}

type RoomSlot = {
  room_id: number
  room_name: string | null
  grade_label: string
  headcount: number
  staff: Person[]
  out_today: StoodDown[]
}

type Block = {
  time_block: TimeBlock
  classes: ClassSlot[]
  rooms: RoomSlot[]
}

type Counselor = { id: number; name: string | null; role: string }

/** One shift on one person's row: a class, or a care room for one block. */
type Entry = {
  kind: 'class' | 'room'
  id: number
  label: string | null
  time_block: TimeBlock | null
  start_time: string | null
  end_time: string | null
  assignment_id: number
  only_today: boolean
}

/** The same assignments as `blocks`, inverted — one row of `M-Staff`. */
type PersonRow = {
  counselor_id: number
  name: string | null
  role: string | null
  blocks: Record<TimeBlock, Entry[]>
  /** Shifts on classes whose hours are still empty, so they have no column. */
  unscheduled: Entry[]
  overlaps: {
    time_block: TimeBlock | null
    places: (string | null)[]
    assignment_ids: number[]
  }[]
  gaps: TimeBlock[]
}

type StaffWarning = {
  code: 'staff_overlap' | 'staff_gap'
  time_block: TimeBlock | null
  counselor_id: number
  label: string | null
  places: (string | null)[]
}

type Schedule = {
  day: Weekday
  date: string | null
  blocks: Block[]
  unscheduled_classes: ClassSlot[]
  counselors: Counselor[]
  people: PersonRow[]
  warnings: { code: string; time_block: string; label: string | null }[]
  staff_warnings: StaffWarning[]
}

/** Which slot a row points at: a class, or a room for one block. */
type Target =
  | { class_session_id: number }
  | { room_id: number; time_block: TimeBlock }

/** "16:45" as "4:45p" — how the sheets have always written it. */
function clock(value: string | null): string {
  if (!value) return '—'
  const [h, m] = value.split(':').map(Number)
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`
}

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * Who is in each class and each care room.
 *
 * This is the screen the whole feature was asked for. Today those lists live in
 * the header of every block on two printed sheets — `Ocean Room (K): Katelyn,
 * LaRae & Lila`, `Bball 3:15p-4p Courts: Fischer, Mattea, Mollie` — retyped by
 * hand every day, then printed four times over and highlighted per person.
 *
 * It is laid out as the sheets are, three time blocks across, because that is
 * how the question gets asked at four o'clock: who is in the Gym right now.
 *
 * BY PLACE AND BY PERSON ARE BOTH REAL QUESTIONS
 *   The office asks the other one while building the week — "what does Mattea
 *   do on Monday", "did I leave anybody with a spare hour" — and it is the
 *   question `M-Staff` exists to answer, one row per counselor with the three
 *   hours across. Neither shape can answer the other's question by being read
 *   harder, so both are here, over one fetch and one set of mutations.
 *
 *   The two views never re-query: the server inverts the same resolved
 *   assignments into `people`, so they cannot come to disagree about who is
 *   where.
 *
 * TWO MODES, AND THE DIFFERENCE MATTERS (R8)
 *   The weekly pattern is every Monday, forever — "theoretically every Monday
 *   should be the same". A date is one afternoon's exceptions: somebody called
 *   out and has to be covered, without next Monday changing.
 *
 *   So in date mode, taking a person out of a slot is NOT a delete. It writes a
 *   "not today" row for that date and leaves the template alone, which is also
 *   what leaves their two colleagues in the block untouched. Deleting would
 *   remove them from every Monday of the season, which is a different decision
 *   made by the same gesture.
 *
 * A slot with nobody in it is called out rather than left to be noticed, since
 * that is a group of children with no adult.
 */
export function AdminStaffSchedule() {
  const qc = useQueryClient()
  const [day, setDay] = useState<Weekday>('Monday')
  // Which mode, and which date — kept apart on purpose. Collapsing them into one
  // nullable value meant switching to the pattern and back reset the date to
  // today, so comparing one afternoon against the pattern lost your place every
  // time, which is the one comparison this screen exists to support.
  const [dated, setDated] = useState(false)
  const [onDate, setOnDate] = useState(isoToday())
  const date = dated ? onDate : null
  // Kept apart from the mode and the day for the same reason those two are kept
  // apart from each other: switching to the other shape of the same afternoon
  // must not move you to a different afternoon.
  const [view, setView] = useState<'place' | 'person'>('place')
  const [error, setError] = useState('')

  const query = date ? `?date=${date}` : `?day=${day}`
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'staff-assignments', query],
    queryFn: () => api<Schedule>(`/api/admin/staff-assignments${query}`),
  })

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['admin', 'staff-assignments'] })
  }

  function fail(e: unknown, fallback: string) {
    setError(e instanceof ApiError ? e.message : fallback)
  }

  const write = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/api/admin/staff-assignments', { method: 'POST', body }),
    onSuccess: () => {
      setError('')
      refresh()
    },
    onError: (e) => fail(e, 'Could not save that change.'),
  })

  const remove = useMutation({
    mutationFn: (id: number) =>
      api(`/api/admin/staff-assignments/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setError('')
      refresh()
    },
    onError: (e) => fail(e, 'Could not remove that assignment.'),
  })

  const busy = write.isPending || remove.isPending

  /** The half of the row that says when: the pattern, or this one date. */
  const when = date ? { assignment_date: date } : { day_of_week: day }

  function addTo(target: Target, counselorId: number) {
    write.mutate({ counselor_id: counselorId, ...target, ...when })
  }

  function dropFrom(target: Target, person: Person) {
    // A dated row is its own thing, so removing it is a delete. A template row
    // in date mode is not: it has to survive, or next week changes too.
    if (!date || person.only_today) {
      remove.mutate(person.assignment_id)
      return
    }
    write.mutate({
      counselor_id: person.counselor_id,
      ...target,
      assignment_date: date,
      status: 'removed',
    })
  }

  /** Undo a stand-down by deleting the "not today" row itself. */
  function putBack(person: StoodDown) {
    remove.mutate(person.assignment_id)
  }

  const gaps = data?.warnings ?? []
  const people = data?.staff_warnings ?? []
  const nothingToStaff = useMemo(
    () =>
      !!data &&
      data.blocks.every((b) => !b.classes.length && !b.rooms.length) &&
      !data.unscheduled_classes.length,
    [data],
  )

  /** Every shift each person already holds, for the "already busy" hint. */
  const shifts = useMemo(() => {
    const map = new Map<number, Entry[]>()
    for (const person of data?.people ?? []) {
      map.set(person.counselor_id, [
        ...BLOCKS.flatMap((b) => person.blocks[b] ?? []),
        ...person.unscheduled,
      ])
    }
    return map
  }, [data])

  /**
   * What this person is already doing at these hours, if anything.
   *
   * Shown next to their name in the picker rather than removing them from it:
   * a hard refusal blocks whatever legitimate case nobody thought of, and this
   * is reversible in one click. A shift whose class has no hours yet is skipped
   * — it cannot be compared, and guessing its hours is what would report two
   * consecutive swim lessons as a clash.
   */
  function busyAt(span: [string, string] | null, counselorId: number) {
    if (!span) return null
    for (const shift of shifts.get(counselorId) ?? []) {
      if (!shift.start_time || !shift.end_time) continue
      if (overlaps(span, [shift.start_time, shift.end_time])) return shift.label
    }
    return null
  }

  function slotProps(target: Target, span: [string, string] | null) {
    return {
      counselors: data?.counselors ?? [],
      busy,
      dated: !!date,
      busyAt: (id: number) => busyAt(span, id),
      onAdd: (id: number) => addTo(target, id),
      onDrop: (p: Person) => dropFrom(target, p),
      onPutBack: putBack,
    }
  }

  return (
    <div className="mx-auto w-full max-w-[95rem]">
      <h1 className="mb-2 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Staff schedule
      </h1>
      <p className="mb-6 max-w-3xl text-[0.95rem] font-medium text-ink-500">
        Who runs each class and who covers each care room, hour by hour. Set a
        weekday once and it repeats all season — this is the list that sits in the
        header of every block on your sheets.
      </p>

      {gaps.length > 0 && (
        <Card className="mb-4 border-2 border-sun-200 bg-sun-50 p-4">
          <div className="flex items-start gap-3">
            <TriangleAlert
              className="mt-0.5 size-5 shrink-0 text-sun-600"
              strokeWidth={2.4}
            />
            <div>
              <p className="font-extrabold text-sun-700">
                {gaps.length === 1
                  ? 'One place has nobody assigned'
                  : `${gaps.length} places have nobody assigned`}
              </p>
              <p className="mt-1 text-[0.9rem] font-medium text-sun-700">
                {gaps
                  .map((w) => `${BLOCK_LABEL[w.time_block as TimeBlock]} ${w.label}`)
                  .join(' · ')}
              </p>
            </div>
          </div>
        </Card>
      )}

      {/* Its own banner rather than a line in the one above. That one counts
          places with nobody in them; these are about a person, and adding them
          to the count would make its own headline untrue. */}
      {people.length > 0 && (
        <Card className="mb-4 border-2 border-sun-200 bg-sun-50 p-4">
          <div className="flex items-start gap-3">
            <UserRoundX
              className="mt-0.5 size-5 shrink-0 text-sun-600"
              strokeWidth={2.4}
            />
            <div>
              <p className="font-extrabold text-sun-700">
                {people.length === 1
                  ? 'One person to look at'
                  : `${people.length} people to look at`}
              </p>
              <ul className="mt-1 text-[0.9rem] font-medium text-sun-700">
                {people.map((w, i) => (
                  <li key={`${w.counselor_id}-${w.code}-${w.time_block}-${i}`}>
                    {w.code === 'staff_overlap'
                      ? `${w.label} is in ${w.places.filter(Boolean).join(' and ')} at the same time`
                      : `${w.label} has nothing from ${BLOCK_LABEL[w.time_block as TimeBlock]}, but is here either side of it`}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      {error && (
        <p className="mb-4 rounded-2xl bg-berry-50 px-4 py-3 text-[0.9rem] font-bold text-berry-600">
          {error}
        </p>
      )}

      {/* Mode first, because it changes what every button below does. */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex gap-1 rounded-full bg-canvas-100 p-1">
          <button
            type="button"
            onClick={() => setDated(false)}
            aria-current={!date ? 'true' : undefined}
            className={`h-8 rounded-full px-3.5 text-[0.82rem] font-bold transition ${
              !date ? 'bg-white text-ink-800 shadow-soft' : 'text-ink-500'
            }`}
          >
            Every week
          </button>
          <button
            type="button"
            onClick={() => setDated(true)}
            aria-current={date ? 'true' : undefined}
            className={`h-8 rounded-full px-3.5 text-[0.82rem] font-bold transition ${
              date ? 'bg-white text-ink-800 shadow-soft' : 'text-ink-500'
            }`}
          >
            One day
          </button>
        </div>

        {date ? (
          <>
            <input
              type="date"
              value={onDate}
              onChange={(e) => setOnDate(e.target.value || isoToday())}
              aria-label="Date"
              className="h-9 rounded-full border-2 border-canvas-200 bg-white px-3 text-[0.85rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
            />
            <p className="text-[0.85rem] font-semibold text-ink-500">
              Changes here apply to {longDate(date)} only. The weekly pattern
              stays as it is.
            </p>
          </>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {WEEKDAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDay(d)}
                aria-current={d === day ? 'true' : undefined}
                className={`h-9 rounded-full px-4 text-sm font-bold transition ${
                  d === day
                    ? 'bg-sky-500 text-white shadow-soft'
                    : 'bg-white text-ink-600 hover:bg-canvas-100'
                }`}
              >
                {d.slice(0, 3)}
              </button>
            ))}
          </div>
        )}

        {/* Last, and set apart: it changes the shape of the answer, not which
            afternoon is being answered about. */}
        <div className="flex gap-1 rounded-full bg-canvas-100 p-1 sm:ms-auto">
          {(
            [
              ['place', 'By place'],
              ['person', 'By person'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setView(key)}
              aria-current={view === key ? 'true' : undefined}
              className={`h-8 rounded-full px-3.5 text-[0.82rem] font-bold transition ${
                view === key ? 'bg-white text-ink-800 shadow-soft' : 'text-ink-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {isPending ? (
        <Skeleton className="h-72" />
      ) : !data ? null : nothingToStaff ? (
        <EmptyState
          icon={<Users className="size-7" strokeWidth={1.8} />}
          title={`Nothing to staff on ${data.day}`}
          body="Add the classes and their hours, and set which grades wait in which care room. Then the blocks to staff appear here."
        />
      ) : view === 'person' ? (
        <PersonGrid
          people={data.people}
          blocks={data.blocks}
          dated={!!date}
          busy={busy}
          onAdd={addTo}
          onDrop={dropFrom}
        />
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-3">
            {data.blocks.map((block) => (
              <section key={block.time_block} className="flex flex-col gap-3">
                <h2 className="px-1 text-[1.05rem] font-extrabold text-ink-900">
                  {BLOCK_LABEL[block.time_block]}
                </h2>
                {block.classes.length === 0 && block.rooms.length === 0 ? (
                  <p className="px-1 text-[0.85rem] font-semibold text-ink-400">
                    Nothing scheduled this hour.
                  </p>
                ) : (
                  <>
                    {block.classes.map((slot) => (
                      <Slot
                        key={`c${slot.id}`}
                        title={slot.name}
                        detail={`${clock(slot.start_time)}–${clock(slot.end_time)}${
                          slot.location ? ` · ${slot.location}` : ''
                        }`}
                        count={slot.enrolled_count}
                        countLabel="enrolled"
                        staff={slot.staff}
                        outToday={slot.out_today}
                        {...slotProps(
                          { class_session_id: slot.id },
                          slot.start_time && slot.end_time
                            ? [slot.start_time, slot.end_time]
                            : null,
                        )}
                      />
                    ))}
                    {block.rooms.map((slot) => (
                      <Slot
                        key={`r${slot.room_id}`}
                        title={`${slot.room_name} (${slot.grade_label})`}
                        detail="Care"
                        count={slot.headcount}
                        countLabel="up to"
                        staff={slot.staff}
                        outToday={slot.out_today}
                        {...slotProps(
                          {
                            room_id: slot.room_id,
                            time_block: block.time_block,
                          },
                          BLOCK_SPAN[block.time_block],
                        )}
                      />
                    ))}
                  </>
                )}
              </section>
            ))}
          </div>

          {data.unscheduled_classes.length > 0 && (
            <Card className="mt-5 border-2 border-canvas-200 p-4">
              <div className="mb-2 flex items-center gap-2">
                <CalendarClock className="size-4 text-ink-400" strokeWidth={2.4} />
                <p className="text-[0.95rem] font-extrabold text-ink-800">
                  Classes with no hours yet
                </p>
              </div>
              <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
                These have no time block to sit in until their hours are filled in
                on the Classes screen. You can still say who runs them.
              </p>
              <div className="grid gap-3 lg:grid-cols-3">
                {data.unscheduled_classes.map((slot) => (
                  <Slot
                    key={`u${slot.id}`}
                    title={slot.name}
                    detail="No hours set"
                    count={slot.enrolled_count}
                    countLabel="enrolled"
                    staff={slot.staff}
                    outToday={slot.out_today}
                    {...slotProps({ class_session_id: slot.id }, null)}
                  />
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  )
}

/** A place somebody can be put, in one hour: what to call it and what to POST. */
type Place = { key: string; label: string; target: Target }

function placesIn(block: Block): Place[] {
  return [
    ...block.classes.map((c) => ({
      key: `c${c.id}`,
      label: c.name,
      target: { class_session_id: c.id } as Target,
    })),
    ...block.rooms.map((r) => ({
      key: `r${r.room_id}`,
      label: `${r.room_name} (${r.grade_label})`,
      target: { room_id: r.room_id, time_block: block.time_block } as Target,
    })),
  ]
}

/**
 * `M-Staff`: one row per person, the three hours across.
 *
 * The same assignments as the grid, and the same two mutations — this is a
 * second way in, not a second source of truth.
 *
 * An empty cell is left EMPTY. Most of the staff leave at five, and on the
 * paper sheet that is a blank cell rather than a mistake; nothing in this app
 * records anybody's contracted hours, so colouring every blank as a problem
 * would put an amber box on almost every row and the real ones would stop being
 * seen. Only two things are called out, and both are claims the data can
 * actually support: an hour nobody gave somebody who is in the building either
 * side of it, and one person in two places at once.
 */
function PersonGrid({
  people,
  blocks,
  dated,
  busy,
  onAdd,
  onDrop,
}: {
  people: PersonRow[]
  blocks: Block[]
  dated: boolean
  busy: boolean
  onAdd: (target: Target, counselorId: number) => void
  onDrop: (target: Target, person: Person) => void
}) {
  const byBlock = new Map(blocks.map((b) => [b.time_block, b]))

  if (people.length === 0) {
    return (
      <EmptyState
        icon={<Users className="size-7" strokeWidth={1.8} />}
        title="No staff yet"
        body="Add counselors and they appear here, one row each, ready to be given their hours."
      />
    )
  }

  return (
    <Card className="overflow-x-auto p-0">
      <table className="w-full min-w-[54rem] border-collapse">
        <thead>
          <tr className="border-b-2 border-canvas-200">
            <th className="w-56 px-4 py-3 text-start text-[0.8rem] font-extrabold tracking-wide text-ink-400 uppercase">
              Person
            </th>
            {BLOCKS.map((block) => (
              <th
                key={block}
                className="px-3 py-3 text-start text-[0.8rem] font-extrabold tracking-wide text-ink-400 uppercase"
              >
                {BLOCK_LABEL[block]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {people.map((person) => (
            <PersonLine
              key={person.counselor_id}
              person={person}
              byBlock={byBlock}
              dated={dated}
              busy={busy}
              onAdd={onAdd}
              onDrop={onDrop}
            />
          ))}
        </tbody>
      </table>
    </Card>
  )
}

function PersonLine({
  person,
  byBlock,
  dated,
  busy,
  onAdd,
  onDrop,
}: {
  person: PersonRow
  byBlock: Map<TimeBlock, Block>
  dated: boolean
  busy: boolean
  onAdd: (target: Target, counselorId: number) => void
  onDrop: (target: Target, person: Person) => void
}) {
  const [picking, setPicking] = useState<TimeBlock | null>(null)

  /** The `Person` the grid's own remove path expects, rebuilt from a shift. */
  function asPerson(entry: Entry): Person {
    return {
      assignment_id: entry.assignment_id,
      counselor_id: person.counselor_id,
      counselor_name: person.name,
      only_today: entry.only_today,
    }
  }

  function targetOf(entry: Entry): Target {
    return entry.kind === 'class'
      ? { class_session_id: entry.id }
      : { room_id: entry.id, time_block: entry.time_block as TimeBlock }
  }

  return (
    <tr className="border-b border-canvas-200 last:border-0 align-top">
      <th scope="row" className="px-4 py-3 text-start">
        <p className="font-extrabold text-ink-900">{person.name}</p>
        {person.role === 'admin' && (
          <span className="text-[0.68rem] font-extrabold tracking-wide text-grape-600 uppercase">
            admin
          </span>
        )}
        {person.unscheduled.length > 0 && (
          <p className="mt-1 text-[0.78rem] font-semibold text-ink-400">
            Also {person.unscheduled.map((e) => e.label).join(', ')} — no hours
            set
          </p>
        )}
      </th>

      {BLOCKS.map((block) => {
        const entries = person.blocks[block] ?? []
        const clash = person.overlaps.some((o) => o.time_block === block)
        const gap = person.gaps.includes(block)
        const taken = new Set(entries.map((e) => `${e.kind[0]}${e.id}`))
        const offered = (byBlock.get(block) ? placesIn(byBlock.get(block)!) : [])
          .filter((p) => !taken.has(p.key))

        return (
          <td
            key={block}
            className={`px-3 py-3 ${
              clash || gap ? 'bg-sun-50/60' : ''
            }`}
          >
            {entries.length > 0 && (
              <ul className="mb-1.5 flex flex-wrap gap-1.5">
                {entries.map((entry) => (
                  <li key={entry.assignment_id}>
                    <span className="inline-flex items-center gap-1 rounded-full bg-canvas-100 py-1 ps-3 pe-1 text-[0.82rem] font-bold text-ink-700">
                      {entry.label}
                      {entry.only_today && (
                        <span className="text-[0.7rem] font-extrabold text-coral-700">
                          covering
                        </span>
                      )}
                      <button
                        type="button"
                        aria-label={
                          dated && !entry.only_today
                            ? `Take ${person.name} out of ${entry.label} for this day`
                            : `Remove ${person.name} from ${entry.label}`
                        }
                        title={
                          dated && !entry.only_today
                            ? 'Take them out for this day only'
                            : undefined
                        }
                        disabled={busy}
                        onClick={() => onDrop(targetOf(entry), asPerson(entry))}
                        className="rounded-full p-1 text-ink-400 hover:bg-white hover:text-berry-600 disabled:opacity-40"
                      >
                        <X className="size-3.5" strokeWidth={2.6} />
                      </button>
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {clash && (
              <p className="mb-1.5 text-[0.8rem] font-bold text-sun-700">
                Two places at once
              </p>
            )}
            {gap && !clash && (
              <p className="mb-1.5 text-[0.8rem] font-bold text-sun-700">
                Nothing this hour
              </p>
            )}

            {picking === block ? (
              <div className="flex flex-wrap gap-1.5">
                {offered.length === 0 ? (
                  <p className="text-[0.82rem] font-semibold text-ink-400">
                    Nothing left to give them this hour.
                  </p>
                ) : (
                  offered.map((place) => (
                    <button
                      key={place.key}
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        onAdd(place.target, person.counselor_id)
                        setPicking(null)
                      }}
                      className="rounded-full bg-sky-50 px-3 py-1 text-[0.82rem] font-bold text-sky-700 hover:bg-sky-100 disabled:opacity-40"
                    >
                      {place.label}
                    </button>
                  ))
                )}
                <button
                  type="button"
                  aria-label="Cancel"
                  onClick={() => setPicking(null)}
                  className="rounded-full p-1.5 text-ink-400 hover:bg-canvas-100"
                >
                  <X className="size-4" strokeWidth={2.4} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                aria-label={`${dated ? 'Cover' : 'Add'} a place for ${person.name} from ${BLOCK_LABEL[block]}`}
                disabled={busy}
                onClick={() => setPicking(block)}
                className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[0.82rem] font-bold text-ink-400 hover:bg-canvas-100 hover:text-ink-700 disabled:opacity-40"
              >
                <Plus className="size-4" strokeWidth={2.6} />
                {dated ? 'Cover' : 'Add'}
              </button>
            )}
          </td>
        )
      })}
    </tr>
  )
}

/**
 * One place at one hour, and who is standing in it.
 *
 * The amber border is the "nobody assigned" cue. It is on the card rather than
 * only in the banner up top, because the banner tells you how many and this
 * tells you which.
 */
function Slot({
  title,
  detail,
  count,
  countLabel,
  staff,
  outToday,
  counselors,
  busy,
  dated,
  busyAt,
  onAdd,
  onDrop,
  onPutBack,
}: {
  title: string
  detail: string
  count: number
  countLabel: string
  staff: Person[]
  outToday: StoodDown[]
  counselors: Counselor[]
  busy: boolean
  /** Viewing one date rather than the weekly pattern. */
  dated: boolean
  /** Where this person already is at these hours, if anywhere. */
  busyAt: (counselorId: number) => string | null
  onAdd: (counselorId: number) => void
  onDrop: (person: Person) => void
  onPutBack: (person: StoodDown) => void
}) {
  const [picking, setPicking] = useState(false)
  const taken = new Set(staff.map((p) => p.counselor_id))
  const available = counselors.filter((c) => !taken.has(c.id))
  const empty = staff.length === 0

  /**
   * Admins can be given a shift too — a director covering a room herself is
   * ordinary — so this list is deliberately not only counselors. But the two
   * read identically once they are names in a pill, and "who are these extra
   * people" is the question the mixed list actually raises. Grape plus the
   * word answers it in place, rather than sending anyone to the Counselors
   * screen to find out who is on staff and who runs the program.
   */
  const isAdmin = (id: number) =>
    counselors.find((c) => c.id === id)?.role === 'admin'

  return (
    <Card
      className={`p-3.5 ${empty ? 'border-2 border-sun-300 bg-sun-50/40' : ''}`}
    >
      <div className="mb-2 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold text-ink-900">{title}</p>
          <p className="text-[0.8rem] font-semibold text-ink-400">
            {detail}
            {count > 0 && (
              <span className="ms-1.5">
                · {countLabel} {count}
              </span>
            )}
          </p>
        </div>
      </div>

      {empty ? (
        <p className="mb-2 text-[0.82rem] font-bold text-sun-700">
          Nobody assigned
        </p>
      ) : (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {staff.map((person) => (
            <li key={person.assignment_id}>
              <span className="inline-flex items-center gap-1 rounded-full bg-canvas-100 py-1 ps-3 pe-1 text-[0.82rem] font-bold text-ink-700">
                {person.counselor_name}
                {isAdmin(person.counselor_id) && (
                  <span className="text-[0.68rem] font-extrabold tracking-wide text-grape-600 uppercase">
                    admin
                  </span>
                )}
                {person.only_today && (
                  <span className="text-[0.7rem] font-extrabold text-coral-700">
                    covering
                  </span>
                )}
                <button
                  type="button"
                  aria-label={
                    dated && !person.only_today
                      ? `Take ${person.counselor_name} out of ${title} for this day`
                      : `Remove ${person.counselor_name} from ${title}`
                  }
                  title={
                    dated && !person.only_today
                      ? 'Take them out for this day only'
                      : undefined
                  }
                  disabled={busy}
                  onClick={() => onDrop(person)}
                  className="rounded-full p-1 text-ink-400 hover:bg-white hover:text-berry-600 disabled:opacity-40"
                >
                  <X className="size-3.5" strokeWidth={2.6} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Standing somebody down is done in a hurry, so the way back has to be
          on the same card rather than something to go looking for. */}
      {outToday.length > 0 && (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {outToday.map((person) => (
            <li key={person.assignment_id}>
              {/* berry-500, not berry-400: only declared tokens emit a utility,
                  and an undeclared one silently falls back to currentColor. */}
              <span className="inline-flex items-center gap-1 rounded-full bg-white py-1 ps-3 pe-1 text-[0.82rem] font-bold text-ink-400 line-through decoration-berry-500">
                {person.counselor_name}
                <button
                  type="button"
                  aria-label={`Put ${person.counselor_name} back in ${title}`}
                  title="Put them back"
                  disabled={busy}
                  onClick={() => onPutBack(person)}
                  className="rounded-full p-1 text-ink-400 no-underline hover:bg-canvas-100 hover:text-sky-600 disabled:opacity-40"
                >
                  <RotateCcw className="size-3.5" strokeWidth={2.6} />
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {picking ? (
        <div className="flex flex-wrap gap-1.5">
          {available.length === 0 ? (
            <p className="text-[0.82rem] font-semibold text-ink-400">
              Everyone is already here.
            </p>
          ) : (
            available.map((c) => {
              // Named rather than hidden, and still clickable. Somebody covering
              // two rooms for ten minutes is a real afternoon; what is not real
              // is finding out about it at four o'clock.
              const elsewhere = busyAt(c.id)
              return (
                <button
                  key={c.id}
                  type="button"
                  disabled={busy}
                  title={
                    elsewhere
                      ? `Already in ${elsewhere} at this hour`
                      : c.role === 'admin'
                        ? 'Admin, not a counselor'
                        : undefined
                  }
                  onClick={() => {
                    onAdd(c.id)
                    setPicking(false)
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[0.82rem] font-bold disabled:opacity-40 ${
                    elsewhere
                      ? 'bg-canvas-100 text-ink-400 hover:bg-canvas-200'
                      : c.role === 'admin'
                        ? 'bg-grape-50 text-grape-600 hover:bg-grape-100'
                        : 'bg-sky-50 text-sky-700 hover:bg-sky-100'
                  }`}
                >
                  {c.name}
                  {elsewhere ? (
                    <span className="text-[0.68rem] font-extrabold tracking-wide text-sun-700">
                      in {elsewhere}
                    </span>
                  ) : (
                    c.role === 'admin' && (
                      <span className="text-[0.68rem] font-extrabold tracking-wide uppercase">
                        admin
                      </span>
                    )
                  )}
                </button>
              )
            })
          )}
          <button
            type="button"
            aria-label="Cancel"
            onClick={() => setPicking(false)}
            className="rounded-full p-1.5 text-ink-400 hover:bg-canvas-100"
          >
            <X className="size-4" strokeWidth={2.4} />
          </button>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setPicking(true)}>
          <Plus className="size-4" strokeWidth={2.6} />
          {dated ? 'Cover' : 'Add'}
        </Button>
      )}
    </Card>
  )
}
