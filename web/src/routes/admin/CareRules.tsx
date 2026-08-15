import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Check, Layers, Plus, Trash2, TriangleAlert, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Card, EmptyState, Pill, Skeleton } from '@/components/ui'

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const
type Weekday = (typeof WEEKDAYS)[number]

const BLOCKS = ['3-4', '4-5', '5-6'] as const
type TimeBlock = (typeof BLOCKS)[number]

/** How the sheets write the blocks. The API only ever says '3-4'. */
const BLOCK_LABEL: Record<TimeBlock, string> = {
  '3-4': '3p – 4p',
  '4-5': '4p – 5p',
  '5-6': '5p – 6p',
}

type Room = { id: number; name: string; active: boolean }

type Rule = {
  id: number
  /** null is the whole-week rule — it applies on every weekday. */
  day_of_week: Weekday | null
  time_block: TimeBlock
  grade_min: number
  grade_max: number
  grade_label: string
  room_id: number
  room_name: string | null
  priority: number
}

type Segment = {
  room_id: number
  room_name: string | null
  grade_min: number
  grade_max: number
  grades: number[]
  grade_label: string
  headcount: number
  rule_ids: number[]
}

type Cell = {
  grade: number
  grade_label: string
  children: number
  room_id: number | null
  room_name: string | null
  rule_id: number | null
  /** Rules that matched but lost the tie-break. Non-empty means an overlap. */
  overruled: number[]
}

type CareRules = {
  day: Weekday
  rules: Rule[]
  blocks: { time_block: TimeBlock; segments: Segment[]; uncovered: number[] }[]
  matrix: { time_block: TimeBlock; cells: Cell[] }[]
  grades: { grade: number; grade_label: string; children: number }[]
  ungraded_children: number
}

const INPUT =
  'h-10 rounded-full border-2 border-canvas-200 bg-white px-3 text-[0.9rem] font-semibold text-ink-800 outline-none focus:border-sky-500'

/** grade_num 0 is kindergarten, and every sheet writes it 'K'. */
function gradeLabel(grade: number): string {
  return grade === 0 ? 'K' : String(grade)
}

/**
 * The highest grade the pickers offer by default.
 *
 * An afterschool ends at fifth grade, so K-12 made both dropdowns a scroll
 * through seven grades nobody enrols — and, worse, a mis-click on one of them
 * writes a rule for a grade the program does not have, which then shows up in
 * the red "grades with no room" line and reads as a real gap.
 *
 * A floor, not a ceiling: a grade with children actually registered in it is
 * always offered, however high. The cap can only ever hide grades the roster
 * is empty of, which is what makes it safe for a JCC that is not this one.
 */
const DEFAULT_TOP_GRADE = 5

/**
 * Care rules: which grade waits in which room, block by block.
 *
 * This is the parenthesised text in the Care sheet's headers — `Ocean Room (K)`,
 * `Gym (1-4)` — which today is retyped by hand every afternoon. The rules are
 * per weekday or for the whole week, and overlaps are allowed on purpose so a
 * one-Wednesday exception can sit on top of the standard week without deleting
 * it. Which rule wins is decided server-side, in the one place that decides it
 * for the routing engine too, and this screen shows the outcome rather than
 * leaving it to be discovered.
 *
 * The headcount on each room is an UPPER BOUND, and says so: it counts everyone
 * registered that weekday whose grade lands there, including children who are in
 * a class for part of the hour. It is here because moving a grade range to
 * balance the rooms is the reason she opens this screen.
 *
 * A grade with no rule is not a blank in a settings page — it is a child the
 * engine has nowhere to send, so it is called out in red and counted at the top.
 */
export function AdminCareRules() {
  const qc = useQueryClient()
  const [day, setDay] = useState<Weekday>('Monday')
  const [adding, setAdding] = useState<TimeBlock | null>(null)
  const [error, setError] = useState('')

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'care-rules', day],
    queryFn: () => api<CareRules>(`/api/admin/care-rules?day=${day}`),
  })

  // Only live rooms can be picked: a rule pointing at an archived room is a
  // destination no sheet will print. The server refuses it too.
  const { data: rooms } = useQuery({
    queryKey: ['admin', 'rooms'],
    queryFn: () => api<Room[]>('/api/admin/rooms'),
  })
  const liveRooms = useMemo(() => (rooms ?? []).filter((r) => r.active), [rooms])

  // `data.grades` is the union of the roster's grades and the ones existing
  // rules name, so only the ones with children in them can raise the cap — a
  // stray K-12 rule from the old dropdown must not keep 6 through 12 alive in
  // the picker that would then let someone write the same rule again.
  const topGrade = useMemo(
    () =>
      (data?.grades ?? [])
        .filter((g) => g.children > 0)
        .reduce((top, g) => Math.max(top, g.grade), DEFAULT_TOP_GRADE),
    [data],
  )

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['admin', 'care-rules'] })
  }

  function fail(e: unknown, fallback: string) {
    setError(e instanceof ApiError ? e.message : fallback)
  }

  const create = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<Rule>('/api/admin/care-rules', { method: 'POST', body }),
    onSuccess: () => {
      setError('')
      setAdding(null)
      refresh()
    },
    onError: (e) => fail(e, 'Could not add that rule.'),
  })

  const destroy = useMutation({
    mutationFn: (id: number) =>
      api<{ deleted: boolean }>(`/api/admin/care-rules/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setError('')
      refresh()
    },
    onError: (e) => fail(e, 'Could not remove that rule.'),
  })

  // Per block, not summed. A gap in one hour was reading as a gap in all three,
  // which turned the one message that has to be trusted into an exaggeration.
  const gaps = (data?.blocks ?? []).filter((b) => b.uncovered.length > 0)

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-2 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Care rooms
      </h1>
      <p className="mb-6 max-w-3xl text-[0.95rem] font-medium text-ink-500">
        Where each grade waits when they are not in a class. Set it once for the
        whole week, or override a single weekday. This is what the header of the
        care sheet says — <em>Ocean Room (K)</em>, <em>Gym (1-4)</em>.
      </p>

      {gaps.length > 0 && (
        <Card className="mb-4 border-2 border-berry-200 bg-berry-50 p-4">
          <div className="flex items-start gap-3">
            <TriangleAlert
              className="mt-0.5 size-5 shrink-0 text-berry-600"
              strokeWidth={2.4}
            />
            <div>
              <p className="font-extrabold text-berry-700">
                {gaps.length === 1
                  ? 'One hour has grades with no room'
                  : `${gaps.length} hours have grades with no room`}
              </p>
              <ul className="mt-1 text-[0.9rem] font-semibold text-berry-700">
                {gaps.map((b) => (
                  <li key={b.time_block}>
                    {BLOCK_LABEL[b.time_block]} — grade{' '}
                    {b.uncovered.map(gradeLabel).join(', ')}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-[0.9rem] font-medium text-berry-700">
                A child in a grade with no rule has nowhere to be, so nothing can
                say where they go when their class lets out.
              </p>
            </div>
          </div>
        </Card>
      )}

      {data && data.ungraded_children > 0 && (
        <p className="mb-4 rounded-2xl bg-sun-50 px-4 py-3 text-[0.9rem] font-semibold text-sun-700">
          {data.ungraded_children}{' '}
          {data.ungraded_children === 1 ? 'child has' : 'children have'} no grade
          on their record, so no rule here can reach them. Fix the grade on the
          child to bring them in.
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
          </button>
        ))}
      </div>

      {isPending ? (
        <Skeleton className="h-64" />
      ) : !data ? null : liveRooms.length === 0 ? (
        <EmptyState
          icon={<Layers className="size-7" strokeWidth={1.8} />}
          title="No rooms yet"
          body="Add your rooms first — Ocean Room, Gym, Playground — then come back and say which grades wait in each."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {BLOCKS.map((block) => {
            const summary = data.blocks.find((b) => b.time_block === block)
            const row = data.matrix.find((m) => m.time_block === block)
            const rules = data.rules.filter((r) => r.time_block === block)
            return (
              <BlockCard
                key={block}
                block={block}
                segments={summary?.segments ?? []}
                uncovered={summary?.uncovered ?? []}
                cells={row?.cells ?? []}
                rules={rules}
                rooms={liveRooms}
                topGrade={topGrade}
                day={day}
                adding={adding === block}
                busy={create.isPending || destroy.isPending}
                onAdd={() => {
                  setError('')
                  setAdding(adding === block ? null : block)
                }}
                onCreate={(body) => create.mutate({ ...body, time_block: block })}
                onDelete={(id) => destroy.mutate(id)}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}

function BlockCard({
  block,
  segments,
  uncovered,
  cells,
  rules,
  rooms,
  topGrade,
  day,
  adding,
  busy,
  onAdd,
  onCreate,
  onDelete,
}: {
  block: TimeBlock
  segments: Segment[]
  uncovered: number[]
  cells: Cell[]
  rules: Rule[]
  rooms: Room[]
  /** Highest grade the pickers offer — see DEFAULT_TOP_GRADE. */
  topGrade: number
  day: Weekday
  adding: boolean
  busy: boolean
  onAdd: () => void
  onCreate: (body: Record<string, unknown>) => void
  onDelete: (id: number) => void
}) {
  const total = segments.reduce((sum, s) => sum + s.headcount, 0)
  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <h2 className="text-[1.05rem] font-extrabold text-ink-900">
          {BLOCK_LABEL[block]}
        </h2>
        {/* The sheet's own header, rebuilt from the rules rather than typed. */}
        <p className="min-w-0 flex-1 text-[0.9rem] font-semibold text-ink-500">
          {segments.length === 0 ? (
            <span className="text-ink-400">No rooms set for this hour</span>
          ) : (
            segments.map((s, i) => (
              <span key={`${s.room_id}-${s.grade_min}`}>
                {i > 0 && <span className="text-ink-300"> · </span>}
                {s.room_name} ({s.grade_label})
              </span>
            ))
          )}
        </p>
        {total > 0 && (
          <Pill>
            up to {total} {total === 1 ? 'child' : 'children'}
          </Pill>
        )}
        <Button size="sm" variant="outline" onClick={onAdd}>
          {adding ? (
            <X className="size-4" strokeWidth={2.4} />
          ) : (
            <Plus className="size-4" strokeWidth={2.6} />
          )}
          {adding ? 'Cancel' : 'Add grades'}
        </Button>
      </div>

      <GradeStrip cells={cells} />

      {uncovered.length > 0 && (
        <p className="mt-2 text-[0.85rem] font-bold text-berry-600">
          {uncovered.length === 1
            ? `Grade ${gradeLabel(uncovered[0])} has`
            : `Grades ${uncovered.map(gradeLabel).join(', ')} have`}{' '}
          no room in this hour.
        </p>
      )}

      {rules.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1.5">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex flex-wrap items-center gap-2 rounded-2xl bg-canvas-100 px-3 py-2"
            >
              <span className="font-bold text-ink-800">
                Grade {rule.grade_label}
              </span>
              <span className="text-ink-400">→</span>
              <span className="font-bold text-ink-800">{rule.room_name}</span>
              {rule.day_of_week === null ? (
                <Pill>every day</Pill>
              ) : (
                <Pill status="coral">{rule.day_of_week} only</Pill>
              )}
              {rule.priority !== 100 && (
                <span className="text-[0.8rem] font-semibold text-ink-400">
                  priority {rule.priority}
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove the rule sending grade ${rule.grade_label} to ${rule.room_name}`}
                disabled={busy}
                onClick={() => onDelete(rule.id)}
                className="ms-auto rounded-full p-1.5 text-ink-400 hover:bg-berry-50 hover:text-berry-600 disabled:opacity-40"
              >
                <Trash2 className="size-4" strokeWidth={2.4} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <AddRule
          rooms={rooms}
          topGrade={topGrade}
          day={day}
          busy={busy}
          onCreate={onCreate}
        />
      )}
    </Card>
  )
}

/**
 * Grade by grade, which room wins — including the ones where nothing does.
 *
 * The columns are the grades the roster actually has, so a JCC with a fifth
 * grade gets a fifth column rather than a hole nobody sees.
 */
function GradeStrip({ cells }: { cells: Cell[] }) {
  if (cells.length === 0) return null
  return (
    <div className="overflow-x-auto">
      <div className="flex gap-1.5">
        {cells.map((cell) => (
          <div
            key={cell.grade}
            title={
              cell.overruled.length > 0
                ? 'More than one rule covers this grade. The most specific one wins.'
                : undefined
            }
            className={`min-w-[5.5rem] flex-1 rounded-2xl border-2 px-2 py-2 text-center ${
              cell.room_id === null
                ? 'border-berry-200 bg-berry-50'
                : 'border-canvas-200 bg-white'
            }`}
          >
            <p className="text-[0.7rem] font-bold text-ink-400">
              Grade {cell.grade_label}
              {cell.children > 0 && (
                <span className="ms-1 font-semibold text-ink-300">
                  ({cell.children})
                </span>
              )}
            </p>
            <p
              className={`truncate text-[0.85rem] font-extrabold ${
                cell.room_id === null ? 'text-berry-600' : 'text-ink-800'
              }`}
            >
              {cell.room_name ?? 'nowhere'}
            </p>
            {cell.overruled.length > 0 && (
              <p className="text-[0.68rem] font-bold text-sky-600">
                over {cell.overruled.length}
              </p>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

function AddRule({
  rooms,
  topGrade,
  day,
  busy,
  onCreate,
}: {
  rooms: Room[]
  topGrade: number
  day: Weekday
  busy: boolean
  onCreate: (body: Record<string, unknown>) => void
}) {
  const [from, setFrom] = useState('0')
  const [to, setTo] = useState('0')
  const [roomId, setRoomId] = useState(String(rooms[0]?.id ?? ''))
  const [wholeWeek, setWholeWeek] = useState(true)

  // The grades a rule can name, which is not the same as the grades on the
  // roster today: she may be setting up a room for a grade that enrols next
  // week. It stops at the program's own top grade all the same — the ones
  // above it are not "next week", they are a different school.
  const options = Array.from({ length: topGrade + 1 }, (_, i) => i)

  return (
    <div className="mt-3 flex flex-wrap items-end gap-2 rounded-2xl bg-canvas-100 px-3 py-3">
      <label className="flex flex-col gap-1">
        <span className="text-[0.75rem] font-bold text-ink-500">Grades</span>
        <select
          value={from}
          onChange={(e) => {
            setFrom(e.target.value)
            if (Number(e.target.value) > Number(to)) setTo(e.target.value)
          }}
          aria-label="Lowest grade"
          className={INPUT}
        >
          {options.map((g) => (
            <option key={g} value={g}>
              {gradeLabel(g)}
            </option>
          ))}
        </select>
      </label>
      <span className="pb-2.5 font-bold text-ink-400">to</span>
      <label className="flex flex-col gap-1">
        <span className="text-[0.75rem] font-bold text-ink-500">&nbsp;</span>
        <select
          value={to}
          onChange={(e) => setTo(e.target.value)}
          aria-label="Highest grade"
          className={INPUT}
        >
          {options
            .filter((g) => g >= Number(from))
            .map((g) => (
              <option key={g} value={g}>
                {gradeLabel(g)}
              </option>
            ))}
        </select>
      </label>
      <label className="flex min-w-[10rem] flex-col gap-1">
        <span className="text-[0.75rem] font-bold text-ink-500">Room</span>
        <select
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          aria-label="Room"
          className={INPUT}
        >
          {rooms.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2 pb-2.5 text-[0.85rem] font-bold text-ink-600">
        <input
          type="checkbox"
          checked={wholeWeek}
          onChange={(e) => setWholeWeek(e.target.checked)}
          className="size-4 accent-sky-500"
        />
        Every day
      </label>
      <Button
        size="sm"
        loading={busy}
        disabled={!roomId}
        className="ms-auto"
        onClick={() =>
          onCreate({
            grade_min: Number(from),
            grade_max: Number(to),
            room_id: Number(roomId),
            day_of_week: wholeWeek ? null : day,
          })
        }
      >
        <Check className="size-4" strokeWidth={2.6} />
        Add
      </Button>
    </div>
  )
}
