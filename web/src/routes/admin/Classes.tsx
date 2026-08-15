import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  BookOpen,
  RotateCcw,
  Sparkles,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { confirmDelete } from '@/lib/confirm'
import { Button, Card, EmptyState, Pill, Skeleton } from '@/components/ui'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const
type Weekday = (typeof WEEKDAYS)[number]

type ClassSession = {
  id: number
  name: string
  day_of_week: Weekday
  /** "HH:MM", or null while nobody has filled it in. */
  start_time: string | null
  end_time: string | null
  location: string | null
  capacity: number | null
  active: boolean
  enrolled_count: number
  /** Read out of the class's own name. A proposal, never a stored value. */
  suggested_start: string | null
  suggested_end: string | null
  warning?: string
}

type Patch = {
  id: number
  name?: string
  start_time?: string | null
  end_time?: string | null
  location?: string | null
  capacity?: string | number | null
  active?: boolean
}

// The border colour is deliberately NOT in the base. Two border-colour utilities
// on one element are resolved by stylesheet order, not by the order they appear
// in the class attribute, so appending `border-sun-300` to a base that already
// says `border-canvas-200` silently loses — and the amber cue on a class with no
// end time is the whole point of this screen.
const INPUT_BASE =
  'h-10 rounded-full border-2 px-3 text-[0.9rem] font-semibold text-ink-800 outline-none focus:border-sky-500'
const INPUT = `${INPUT_BASE} border-canvas-200 bg-white`
const INPUT_NEEDED = `${INPUT_BASE} border-sun-400 bg-sun-50`

/** "16:45" as "4:45p" — how the sheets have always written it. */
function clock(value: string | null): string {
  if (!value) return '—'
  const [h, m] = value.split(':').map(Number)
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`
}

/**
 * The class catalogue: where the hours come from.
 *
 * The roster importer creates a row per class name per weekday and leaves the
 * hours, room and capacity empty, because the spreadsheet's M/T/W/R/F columns
 * hold free text like "Crafting 4p-4:45p" and no separate time field. This is
 * the screen that fills them in — and until it has been used, nothing
 * downstream can answer a question: the routing rule compares a class's end
 * against the child's dismissal hour, so a class with no end has no computable
 * destination and a child with no destination is the bug that shows up at 4pm.
 *
 * Which is why the missing-hours count sits at the top rather than being
 * something you notice by scrolling.
 */
export function AdminClasses() {
  const qc = useQueryClient()
  const [day, setDay] = useState<Weekday>('Monday')
  const [showArchived, setShowArchived] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  // One fetch for the whole week, so the tabs are instant and the count at the
  // top is about the program rather than about the tab you happen to be on.
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'class-sessions', showArchived],
    queryFn: () =>
      api<ClassSession[]>(
        `/api/admin/class-sessions${showArchived ? '?include_inactive=1' : ''}`,
      ),
  })

  const classes = data ?? []
  const forDay = useMemo(
    () => classes.filter((c) => c.day_of_week === day),
    [classes, day],
  )
  const perDay = useMemo(() => {
    const counts = {} as Record<Weekday, number>
    for (const d of WEEKDAYS) counts[d] = 0
    for (const c of classes) counts[c.day_of_week] += 1
    return counts
  }, [classes])

  // "No end time" is the one that blocks routing; a missing start only affects
  // chaining. They are counted separately so the banner can be specific.
  const noEnd = classes.filter((c) => c.active && !c.end_time)
  const suggestable = noEnd.filter((c) => c.suggested_end)

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['admin', 'class-sessions'] })
  }

  function fail(e: unknown, fallback: string) {
    setError(e instanceof ApiError ? e.message : fallback)
  }

  const save = useMutation({
    mutationFn: ({ id, ...body }: Patch) =>
      api<ClassSession>(`/api/admin/class-sessions/${id}`, {
        method: 'PUT',
        body,
      }),
    onSuccess: (updated) => {
      setError('')
      // The server warns when a rename happens, because renaming has a
      // consequence no field on this screen shows.
      setNotice(updated.warning ?? '')
      refresh()
    },
    onError: (e) => fail(e, 'Could not save that class.'),
  })

  const destroy = useMutation({
    mutationFn: (id: number) =>
      api<{ deleted: boolean }>(`/api/admin/class-sessions/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setError('')
      refresh()
    },
    onError: (e) => fail(e, 'Could not delete that class.'),
  })

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-2 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Classes
      </h1>
      <p className="mb-6 max-w-3xl text-[0.95rem] font-medium text-ink-500">
        One row per class per weekday — the same class on Monday and Wednesday
        can run at different times, in a different room, with a different list.
        The roster import creates these from your spreadsheet but cannot know the
        hours, so they start empty.
      </p>

      {noEnd.length > 0 && (
        <Card className="mb-4 border-2 border-sun-200 bg-sun-50 p-4">
          <div className="flex flex-wrap items-start gap-3">
            <TriangleAlert
              className="mt-0.5 size-5 shrink-0 text-sun-600"
              strokeWidth={2.4}
            />
            <div className="min-w-0 flex-1">
              <p className="font-extrabold text-sun-700">
                {noEnd.length} {noEnd.length === 1 ? 'class has' : 'classes have'}{' '}
                no end time
              </p>
              <p className="mt-1 text-[0.9rem] font-medium text-sun-700">
                Without one there is no way to work out where a child goes when
                the class lets out — whether a parent collects them from the
                instructor, or they wait in a care room.
              </p>
            </div>
            {suggestable.length > 0 && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setReviewing((v) => !v)}
              >
                <Sparkles className="size-4" strokeWidth={2.4} />
                {reviewing ? 'Hide' : `Review ${suggestable.length}`}
              </Button>
            )}
          </div>
        </Card>
      )}

      {reviewing && (
        <SuggestionsPanel
          candidates={suggestable}
          onDone={(count) => {
            setReviewing(false)
            setNotice(
              count > 0
                ? `Filled in ${count} ${count === 1 ? 'class' : 'classes'}.`
                : '',
            )
            refresh()
          }}
          onError={(e) => fail(e, 'Could not apply those hours.')}
        />
      )}

      {notice && (
        <p className="mb-4 rounded-2xl bg-sky-50 px-4 py-3 text-[0.9rem] font-semibold text-sky-700">
          {notice}
        </p>
      )}
      {error && (
        <p className="mb-4 rounded-2xl bg-berry-50 px-4 py-3 text-[0.9rem] font-bold text-berry-600">
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-wrap gap-1.5">
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
            <span
              className={`ms-2 text-xs ${d === day ? 'text-white/70' : 'text-ink-400'}`}
            >
              {perDay[d]}
            </span>
          </button>
        ))}
      </div>

      {isPending ? (
        <Skeleton className="h-48" />
      ) : forDay.length === 0 ? (
        <EmptyState
          icon={<BookOpen className="size-7" strokeWidth={1.8} />}
          title={`No classes on ${day}`}
          body="Import a roster with the class columns filled in, or add one by hand below."
        />
      ) : (
        <>
          {/* The column names once, not on all fifteen rows. Each input keeps
              its own aria-label, so nothing is lost for a screen reader. */}
          <div
            aria-hidden
            className="mb-1 hidden gap-2 px-4 text-[0.72rem] font-bold text-ink-400 lg:flex"
          >
            <span className="min-w-[13rem] flex-1">Class</span>
            <span className="w-32">Starts</span>
            <span className="w-32">Ends</span>
            <span className="w-28">Where</span>
            <span className="w-20">Cap</span>
            <span className="w-[9.5rem]" />
          </div>
          <ul className="flex flex-col gap-2">
            {forDay.map((session) => (
              <ClassRow
                key={session.id}
                session={session}
                saving={save.isPending}
                onSave={(patch) => save.mutate({ id: session.id, ...patch })}
                onDelete={async () => {
                  if (await confirmDelete(session.name)) destroy.mutate(session.id)
                }}
              />
            ))}
          </ul>
        </>
      )}

      <AddClass
        day={day}
        onAdded={() => {
          setError('')
          refresh()
        }}
        onError={(e) => fail(e, 'Could not add that class.')}
      />

      <button
        type="button"
        onClick={() => setShowArchived((v) => !v)}
        className="mt-4 text-[0.85rem] font-bold text-ink-500 underline decoration-canvas-200 underline-offset-4 hover:text-ink-700"
      >
        {showArchived ? 'Hide archived classes' : 'Show archived classes'}
      </button>
    </div>
  )
}

/**
 * The accept step for hours read out of a class's own name.
 *
 * Every box starts ticked, because in the sample every parse was right — but the
 * ticks exist so that a wrong one can be left behind. Nothing is written until
 * Apply, and the endpoint refuses to touch a class whose hours somebody already
 * typed.
 */
function SuggestionsPanel({
  candidates,
  onDone,
  onError,
}: {
  candidates: ClassSession[]
  onDone: (applied: number) => void
  onError: (e: unknown) => void
}) {
  const [chosen, setChosen] = useState<number[]>(() => candidates.map((c) => c.id))

  const apply = useMutation({
    mutationFn: () =>
      api<{ applied: ClassSession[]; skipped: unknown[] }>(
        '/api/admin/class-sessions/apply-time-suggestions',
        { method: 'POST', body: { ids: chosen } },
      ),
    onSuccess: (result) => onDone(result.applied.length),
    onError,
  })

  function toggle(id: number) {
    setChosen((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    )
  }

  return (
    <Card className="mb-4 p-4">
      <p className="mb-1 font-extrabold text-ink-800">Hours from the names</p>
      <p className="mb-3 text-[0.9rem] font-medium text-ink-500">
        These are read straight out of what the spreadsheet called each class.
        Untick anything that looks wrong — nothing is saved until you apply, and
        a class whose hours you already typed is never overwritten.
      </p>
      <ul className="mb-3 flex flex-col gap-1">
        {candidates.map((c) => (
          <li key={c.id}>
            <label className="flex cursor-pointer flex-wrap items-center gap-2 rounded-2xl px-3 py-2 hover:bg-canvas-100">
              <input
                type="checkbox"
                checked={chosen.includes(c.id)}
                onChange={() => toggle(c.id)}
                className="size-4 accent-sky-500"
              />
              <span className="text-[0.78rem] font-bold text-ink-400">
                {c.day_of_week.slice(0, 3)}
              </span>
              <span className="font-semibold text-ink-700">{c.name}</span>
              <Pill status="leaf">
                {clock(c.suggested_start)} – {clock(c.suggested_end)}
              </Pill>
            </label>
          </li>
        ))}
      </ul>
      <Button
        size="sm"
        disabled={chosen.length === 0}
        loading={apply.isPending}
        onClick={() => apply.mutate()}
      >
        Apply {chosen.length}
      </Button>
    </Card>
  )
}

/**
 * One class, editable in place.
 *
 * Save happens on blur rather than behind a button: there are around fifteen
 * classes a day and four fields each, and a director filling in a season should
 * be tabbing through them, not clicking Save sixty times.
 */
function ClassRow({
  session,
  saving,
  onSave,
  onDelete,
}: {
  session: ClassSession
  saving: boolean
  onSave: (patch: Omit<Patch, 'id'>) => void
  onDelete: () => void
}) {
  const [name, setName] = useState(session.name)
  const [start, setStart] = useState(session.start_time ?? '')
  const [end, setEnd] = useState(session.end_time ?? '')
  const [where, setWhere] = useState(session.location ?? '')
  const [capacity, setCapacity] = useState(
    session.capacity === null ? '' : String(session.capacity),
  )

  // Local state is an edit buffer; the server holds the record. When the server's
  // value changes underneath — a bulk suggestion was applied, another admin
  // saved — the buffer has to follow it, or applying seven suggestions leaves
  // seven inputs looking empty and the screen reads as if nothing happened.
  //
  // Adjusting state during render is React's own recipe for this, and unlike
  // remounting the row through its `key` it does not steal focus from the field
  // being tabbed into — which matters on a screen built for tabbing.
  const [server, setServer] = useState(session)
  if (server !== session) {
    if (session.name !== server.name) setName(session.name)
    if (session.start_time !== server.start_time) setStart(session.start_time ?? '')
    if (session.end_time !== server.end_time) setEnd(session.end_time ?? '')
    if (session.location !== server.location) setWhere(session.location ?? '')
    if (session.capacity !== server.capacity) {
      setCapacity(session.capacity === null ? '' : String(session.capacity))
    }
    setServer(session)
  }

  /** Only write when the field actually changed, so a blur is not a mutation. */
  function commit<T>(current: T, original: T, patch: Omit<Patch, 'id'>) {
    if (current !== original) onSave(patch)
  }

  return (
    <li
      className={`flex flex-wrap items-center gap-2 rounded-2xl px-4 py-3 shadow-soft ${
        session.active ? 'bg-white' : 'bg-canvas-100'
      }`}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => commit(name.trim(), session.name, { name })}
        aria-label={`Name of ${session.name}`}
        className={`${INPUT} min-w-[13rem] flex-1`}
      />
      <input
        type="time"
        value={start}
        onChange={(e) => setStart(e.target.value)}
        onBlur={() =>
          commit(start, session.start_time ?? '', { start_time: start || null })
        }
        aria-label={`Start time of ${session.name}`}
        className={`${INPUT} w-32`}
      />
      {/* Amber until it has a value: this is the field that decides whether the
          child is handed to a parent or walked to a care room. */}
      <input
        type="time"
        value={end}
        onChange={(e) => setEnd(e.target.value)}
        onBlur={() => commit(end, session.end_time ?? '', { end_time: end || null })}
        aria-label={`End time of ${session.name}`}
        title={session.end_time ? undefined : 'Needed to work out where this class lets out to'}
        className={`${session.end_time ? INPUT : INPUT_NEEDED} w-32`}
      />
      {/* The placeholder is a dash rather than a sample room name: with a real
          "Courts" two rows up, a greyed "Courts" reads as a value, not a hint. */}
      <input
        value={where}
        onChange={(e) => setWhere(e.target.value)}
        onBlur={() =>
          commit(where.trim(), session.location ?? '', {
            location: where || null,
          })
        }
        placeholder="—"
        aria-label={`Location of ${session.name}`}
        className={`${INPUT} w-28`}
      />
      <input
        value={capacity}
        onChange={(e) => setCapacity(e.target.value)}
        onBlur={() =>
          commit(capacity, session.capacity === null ? '' : String(session.capacity), {
            capacity: capacity || null,
          })
        }
        inputMode="numeric"
        placeholder="—"
        aria-label={`Capacity of ${session.name}`}
        className={`${INPUT} w-20`}
      />

      <div className="flex w-[9.5rem] items-center gap-2">
        <Pill status="neutral">
          {session.enrolled_count} {session.enrolled_count === 1 ? 'kid' : 'kids'}
        </Pill>
        {!session.active && <Pill status="neutral">Archived</Pill>}
        {session.active ? (
          <button
            type="button"
            aria-label={`Archive ${session.name}`}
            disabled={saving}
            onClick={() => onSave({ active: false })}
            className="rounded-full p-1.5 text-ink-400 hover:bg-berry-50 hover:text-berry-600"
          >
            <Archive className="size-4" strokeWidth={2.2} />
          </button>
        ) : (
          <>
            <button
              type="button"
              aria-label={`Restore ${session.name}`}
              onClick={() => onSave({ active: true })}
              className="rounded-full p-1.5 text-ink-400 hover:bg-leaf-50 hover:text-leaf-600"
            >
              <RotateCcw className="size-4" strokeWidth={2.2} />
            </button>
            {/* The endpoint still refuses this while any child is enrolled. */}
            <button
              type="button"
              aria-label={`Delete ${session.name} for good`}
              onClick={onDelete}
              className="rounded-full p-1.5 text-ink-400 hover:bg-berry-50 hover:text-berry-600"
            >
              <Trash2 className="size-4" strokeWidth={2.2} />
            </button>
          </>
        )}
      </div>
    </li>
  )
}

/** For the swim lesson and the late signup the spreadsheet never mentioned. */
function AddClass({
  day,
  onAdded,
  onError,
}: {
  day: Weekday
  onAdded: () => void
  onError: (e: unknown) => void
}) {
  const [name, setName] = useState('')
  const [start, setStart] = useState('')
  const [end, setEnd] = useState('')
  const [where, setWhere] = useState('')

  const add = useMutation({
    mutationFn: () =>
      api<ClassSession>('/api/admin/class-sessions', {
        method: 'POST',
        body: {
          name,
          day_of_week: day,
          start_time: start || null,
          end_time: end || null,
          location: where || null,
        },
      }),
    onSuccess: () => {
      setName('')
      setStart('')
      setEnd('')
      setWhere('')
      onAdded()
    },
    onError,
  })

  return (
    <Card className="mt-4 p-4">
      <p className="mb-3 text-[0.85rem] font-bold text-ink-500">
        Add a class on {day}
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Pvt Swim"
          aria-label="New class name"
          className={`${INPUT} min-w-[12rem] flex-1`}
        />
        <input
          type="time"
          value={start}
          onChange={(e) => setStart(e.target.value)}
          aria-label="New class start time"
          className={`${INPUT} w-32`}
        />
        <input
          type="time"
          value={end}
          onChange={(e) => setEnd(e.target.value)}
          aria-label="New class end time"
          className={`${INPUT} w-32`}
        />
        <input
          value={where}
          onChange={(e) => setWhere(e.target.value)}
          placeholder="Pool"
          aria-label="New class location"
          className={`${INPUT} w-28`}
        />
        <Button
          size="sm"
          disabled={!name.trim()}
          loading={add.isPending}
          onClick={() => add.mutate()}
        >
          Add
        </Button>
      </div>
    </Card>
  )
}
