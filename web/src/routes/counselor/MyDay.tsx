import { useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  CalendarOff,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheckBig,
  Clock,
  TriangleAlert,
} from 'lucide-react'
import { api } from '@/lib/api'
import {
  checkKey,
  useBlockChecks,
  useSetBlockChecks,
  type BlockRef,
} from '@/lib/blockChecks'
import { hasAllergy, shortAllergy } from '@/lib/roster'
import { Card, EmptyState, Skeleton } from '@/components/ui'

type Child = {
  child_id: number
  name: string
  grade_label: string | null
  school: string | null
  dismissal_time: number | null
  allergies: string | null
  absent: boolean
  /** Classes only: where this child goes when the class lets out. */
  dismiss_to?: string | null
  dismiss_kind?: 'class' | 'parents' | 'care' | 'unknown'
  chained?: boolean
  /** Care only: here for part of the hour, because of a class. */
  partial?: boolean
  from_class?: string | null
  to_class?: string | null
}

type Block = {
  kind: 'class' | 'care'
  class_id?: number
  room_id?: number
  title: string | null
  start_time: string | null
  end_time: string | null
  location?: string | null
  time_block?: string
  with: { counselor_id: number; name: string | null }[]
  children: Child[]
  present_count: number
}

type MyDay = {
  date: string
  day: string
  closed: boolean
  blocks: Block[]
  warnings?: { code: string; child_name: string | null; message: string }[]
}

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

function shiftDate(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00`)
  d.setDate(d.getDate() + days)
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

/** "16:45" as "4:45p" — how the sheets have always written it. */
function clock(value: string | null | undefined): string {
  if (!value) return '—'
  const [h, m] = value.split(':').map(Number)
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`
}

/** The pickup hour as the sheets write it: 3, 4, 5 or 6. Null is never 6. */
function pickup(hour: number | null): string {
  return hour === null ? '—' : `${hour}:00p`
}

function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

function minutesNow(): number {
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

function toMinutes(hhmm: string | null | undefined): number | null {
  if (!hhmm) return null
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

function blockRef(block: Block): BlockRef | null {
  if (block.kind === 'class' && block.class_id != null) {
    return { kind: 'class', id: block.class_id }
  }
  if (block.kind === 'care' && block.room_id != null && block.time_block) {
    return { kind: 'room', id: block.room_id, time_block: block.time_block }
  }
  return null
}

/* ── Grouping ────────────────────────────────────────────────────────── */

type Group = {
  id: string
  name: string
  /** Answers "is this their last stop", which the destination alone does not. */
  when: string
  kind: 'parents' | 'next' | 'care' | 'unknown'
  children: Child[]
}

/**
 * The children of one block, arranged the way the counselor's next five minutes
 * are arranged.
 *
 * A CLASS groups by `Dismiss To`, because when a class lets out the job is not
 * "read the register", it is "walk these four to the Ocean Room and hand those
 * two to their parents". Alphabetical order spreads that job evenly across the
 * whole list; the destination collects it.
 *
 * A CARE ROOM has no destination — the children are already where they are
 * going — so it groups by dismissal hour, which is the same question one hour
 * later: who leaves at 5, who leaves at 6.
 *
 * Within a group, sorted by name. The office's own sheets are alphabetical, and
 * cross-checking a printed page line by line is a thing that still happens.
 */
function groupsFor(block: Block): Group[] {
  const map = new Map<string, Group>()
  const add = (key: string, g: Omit<Group, 'children'>, child: Child) => {
    const found = map.get(key)
    if (found) found.children.push(child)
    else map.set(key, { ...g, children: [child] })
  }

  for (const child of block.children) {
    if (block.kind === 'class') {
      const kind =
        child.dismiss_kind === 'parents'
          ? 'parents'
          : child.dismiss_kind === 'class'
            ? 'next'
            : child.dismiss_kind === 'unknown'
              ? 'unknown'
              : 'care'
      const name =
        kind === 'unknown'
          ? 'No destination on file'
          : kind === 'parents'
            ? `Parent pickup at ${block.location ?? 'the classroom'}`
            : kind === 'next'
              ? `→ ${child.dismiss_to}`
              : (child.dismiss_to ?? 'Care')
      const when =
        kind === 'parents'
          ? `${clock(block.end_time)} · leaves the building`
          : kind === 'next'
            ? `Continues at ${clock(block.end_time)}`
            : kind === 'unknown'
              ? 'Ask the office before the block ends'
              : 'Care until pickup'
      add(`${kind}:${name}`, { id: `${kind}:${name}`, name, when, kind }, child)
    } else {
      const hour = child.dismissal_time
      const name = hour === null ? 'No dismissal time on file' : `Leaves at ${pickup(hour)}`
      const when =
        hour === null
          ? 'Ask the office'
          : child.to_class
            ? 'Some continue to another activity'
            : 'Last stop before pickup'
      add(`h:${hour ?? 'x'}`, { id: `h:${hour ?? 'x'}`, name, when, kind: 'care' }, child)
    }
  }

  const order = { parents: 0, next: 1, care: 2, unknown: 3 }
  return [...map.values()]
    .map((g) => ({
      ...g,
      children: g.children.sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort(
      (a, b) =>
        order[a.kind] - order[b.kind] || a.name.localeCompare(b.name),
    )
}

/* ── The screen ──────────────────────────────────────────────────────── */

/**
 * One counselor's own afternoon.
 *
 * This replaces the marker: the director used to print all four sheets for
 * every counselor and highlight each person's blocks by hand (R9).
 *
 * WHAT CHANGED, AND WHY
 *   It was one flat column — every class, then every child, three stacked lines
 *   each, sorted by first name. A 16-child class ran about 1,400px of scroll,
 *   so the counselor scrolled past other people's blocks to reach their own and
 *   then scrolled again to find one child.
 *
 *   Now the day is a timeline you pick from, and only the picked block is
 *   drawn. Inside it the children are grouped by where they go next, in columns
 *   that sit side by side on a tablet, so the whole routing plan is one view.
 *
 * THE ALLERGY FIX IS THE POINT
 *   Every child used to render a red alert icon reading `n/a`, which is a
 *   placeholder styled as an emergency. Sixteen of them buried the two children
 *   who actually carry one. `hasAllergy()` (lib/roster.ts) is what tells the
 *   difference — a raw truthy check on the field passes "N/A" and "Ninguna"
 *   right through, since a spreadsheet's "no" is still non-empty text. A child
 *   with no real allergy now renders NOTHING — no icon, no dash, no reserved
 *   column — and the ones who do get a red bar under their name that opens the
 *   full list.
 */
export function CounselorMyDay() {
  // `?date=` so a push notification can deep-link to the afternoon it is about.
  const [params] = useSearchParams()
  const requested = params.get('date')
  const [date, setDate] = useState(
    requested && /^\d{4}-\d{2}-\d{2}$/.test(requested) ? requested : isoToday(),
  )
  const [picked, setPicked] = useState<number | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ['counselor', 'my-day', date],
    queryFn: () => api<MyDay>(`/api/counselor/my-day?date=${date}`),
  })

  const blocks = data?.blocks ?? []
  const isToday = date === isoToday()

  // Which block is "now". Only meaningful for today; on any other date the
  // first block is simply the one that opens, and nothing claims to be live.
  const nowIndex = useMemo(() => {
    if (!isToday || !blocks.length) return -1
    const now = minutesNow()
    return blocks.findIndex((b) => {
      const start = toMinutes(b.start_time)
      const end = toMinutes(b.end_time)
      return start !== null && end !== null && now >= start && now < end
    })
  }, [blocks, isToday])

  const index = picked ?? (nowIndex >= 0 ? nowIndex : 0)
  const block = blocks[index]

  const summary = useMemo(() => {
    const seen = new Set<number>()
    let seats = 0
    const allergic = new Set<number>()
    for (const b of blocks) {
      for (const c of b.children) {
        seats += 1
        seen.add(c.child_id)
        if (hasAllergy(c.allergies)) allergic.add(c.child_id)
      }
    }
    return { distinct: seen.size, seats, allergic: allergic.size }
  }, [blocks])

  return (
    <div className="flex min-h-dvh flex-col px-4 pt-4 pb-6 md:px-6 lg:h-dvh lg:overflow-hidden">
      <header className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[1.6rem] font-extrabold tracking-tight text-ink-900 lg:text-[1.9rem]">
            My day
          </h1>
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() => {
              setDate((d) => shiftDate(d, -1))
              setPicked(null)
            }}
            className="flex size-11 items-center justify-center rounded-full bg-white text-ink-500 shadow-soft active:bg-canvas-100"
          >
            <ChevronLeft className="size-5" strokeWidth={2.6} />
          </button>
          <p className="min-w-40 text-center text-[0.95rem] font-extrabold text-ink-800">
            {longDate(date)}
            {isToday && (
              <span className="ms-1.5 text-[0.75rem] font-bold text-sky-600">
                today
              </span>
            )}
          </p>
          <button
            type="button"
            aria-label="Next day"
            onClick={() => {
              setDate((d) => shiftDate(d, 1))
              setPicked(null)
            }}
            className="flex size-11 items-center justify-center rounded-full bg-white text-ink-500 shadow-soft active:bg-canvas-100"
          >
            <ChevronRight className="size-5" strokeWidth={2.6} />
          </button>
        </div>

        {/* Concrete, not a slogan. These are the four numbers a counselor
            plans an afternoon against. `distinct` rather than `seats`, with
            the difference named, so a child who appears in two consecutive
            classes never reads as a duplicate row. */}
        {blocks.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.9rem] font-bold text-ink-600">
            <span>
              <b className="text-[1.05rem] font-extrabold text-ink-900">
                {summary.distinct}
              </b>{' '}
              {summary.distinct === 1 ? 'child' : 'children'}
            </span>
            <span className="text-canvas-200">|</span>
            <span>
              <b className="text-[1.05rem] font-extrabold text-ink-900">
                {blocks.length}
              </b>{' '}
              {blocks.length === 1 ? 'block' : 'blocks'}
            </span>
            {summary.allergic > 0 && (
              <>
                <span className="text-canvas-200">|</span>
                <span className="text-berry-600">
                  <b className="text-[1.05rem] font-extrabold">
                    {summary.allergic}
                  </b>{' '}
                  with allergies
                </span>
              </>
            )}
            {summary.seats > summary.distinct && (
              <>
                <span className="text-canvas-200">|</span>
                <span className="font-semibold text-ink-500">
                  {summary.seats - summary.distinct} continue between blocks
                </span>
              </>
            )}
          </div>
        )}
      </header>

      {isPending ? (
        <Skeleton className="h-64" />
      ) : !data ? null : data.closed ? (
        <EmptyState
          icon={<CalendarOff className="size-7" strokeWidth={1.8} />}
          title="The program does not run this day"
          body="Pick a weekday to see your blocks."
        />
      ) : blocks.length === 0 ? (
        <EmptyState
          icon={<CalendarOff className="size-7" strokeWidth={1.8} />}
          title="Nothing assigned to you"
          body="When the office puts you in a class or a care room for this day, it shows up here."
        />
      ) : (
        <>
          {data.warnings && data.warnings.length > 0 && (
            <Card className="mb-3 flex items-start gap-3 border-2 border-sun-200 bg-sun-50 p-3">
              <TriangleAlert
                className="mt-0.5 size-5 shrink-0 text-sun-600"
                strokeWidth={2.4}
              />
              <p className="text-[0.88rem] font-bold text-sun-700">
                {data.warnings.length === 1
                  ? "One child's day is incomplete"
                  : `${data.warnings.length} children's days are incomplete`}{' '}
                <span className="font-medium">
                  — ask the office before the block starts. The app does not
                  guess where a child goes.
                </span>
              </p>
            </Card>
          )}

          <div className="flex min-h-0 flex-1 flex-col gap-3 lg:flex-row lg:gap-4">
            <Timeline
              blocks={blocks}
              index={index}
              nowIndex={nowIndex}
              date={date}
              onPick={setPicked}
            />
            {block && <BlockPane block={block} date={date} isToday={isToday} />}
          </div>
        </>
      )}
    </div>
  )
}

/* ── Left: the day, as a list you pick from ──────────────────────────── */

function Timeline({
  blocks,
  index,
  nowIndex,
  date,
  onPick,
}: {
  blocks: Block[]
  index: number
  nowIndex: number
  date: string
  onPick: (i: number) => void
}) {
  const { data: checks } = useBlockChecks(date)

  return (
    // A column beside the block on a tablet; a horizontal strip that scrolls
    // across the top on a phone, where a 30% column would leave nothing for
    // the children.
    <nav
      aria-label="Your blocks"
      className="flex shrink-0 gap-2.5 overflow-x-auto pb-1 lg:w-64 lg:flex-col lg:overflow-x-visible lg:overflow-y-auto lg:pb-0 xl:w-72"
    >
      {blocks.map((b, i) => {
        const ref = blockRef(b)
        const expected = b.children.filter((c) => !c.absent)
        const done = ref
          ? expected.filter((c) => checks?.has(checkKey(ref, c.child_id))).length
          : 0
        const complete = expected.length > 0 && done === expected.length
        const isNow = i === nowIndex
        const active = i === index
        return (
          <button
            key={`${b.kind}${i}`}
            type="button"
            onClick={() => onPick(i)}
            aria-current={active}
            className={`flex min-w-56 shrink-0 flex-col gap-1 rounded-card border-s-4 bg-white p-3 text-start shadow-soft transition-colors active:bg-canvas-100 lg:min-w-0 ${
              active ? 'ring-2 ring-sky-500' : ''
            } ${
              complete
                ? 'border-s-leaf-500'
                : isNow
                  ? 'border-s-sky-500'
                  : 'border-s-canvas-200'
            }`}
          >
            <span className="text-[0.8rem] font-extrabold text-ink-500">
              {clock(b.start_time)} – {clock(b.end_time)}
            </span>
            <span
              className={`text-[1.05rem] leading-tight font-extrabold tracking-tight ${
                complete ? 'text-ink-500' : 'text-ink-900'
              }`}
            >
              {b.title}
            </span>
            <span className="text-[0.8rem] font-semibold text-ink-400">
              {b.location ?? (b.kind === 'care' ? 'Care' : '')}
              {b.location && b.kind === 'care' ? ' · Care' : ''}
              {expected.length > 0 &&
                `${b.location || b.kind === 'care' ? ' · ' : ''}${expected.length} ${
                  expected.length === 1 ? 'child' : 'children'
                }`}
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1.5">
              {complete ? (
                <span className="inline-flex items-center gap-1 rounded-full bg-leaf-50 px-2.5 py-1 text-[0.76rem] font-extrabold text-leaf-700">
                  <CircleCheckBig className="size-3.5" strokeWidth={2.4} />
                  All {expected.length} confirmed
                </span>
              ) : (
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[0.76rem] font-extrabold ${
                    isNow
                      ? 'bg-sky-50 text-sky-700'
                      : 'bg-canvas-100 text-ink-500'
                  }`}
                >
                  {isNow && <Clock className="size-3.5" strokeWidth={2.4} />}
                  {isNow ? `Now · ${done} of ${expected.length}` : `${done} of ${expected.length}`}
                </span>
              )}
              {/* Which blocks hold an allergy child, before you open them. */}
              {b.children.some((c) => hasAllergy(c.allergies)) && (
                <span className="inline-flex items-center gap-1 rounded-full bg-berry-50 px-2 py-1 text-[0.76rem] font-extrabold text-berry-700">
                  <TriangleAlert className="size-3.5" strokeWidth={2.4} />
                  {b.children.filter((c) => hasAllergy(c.allergies)).length}
                </span>
              )}
            </span>
          </button>
        )
      })}
    </nav>
  )
}

/* ── Right: one block, in full ───────────────────────────────────────── */

function BlockPane({
  block,
  date,
  isToday,
}: {
  block: Block
  date: string
  isToday: boolean
}) {
  const groups = useMemo(() => groupsFor(block), [block])
  const ref = blockRef(block)
  const { data: checks } = useBlockChecks(date)
  const setChecks = useSetBlockChecks(date)

  const expected = block.children.filter((c) => !c.absent)
  const done = ref
    ? expected.filter((c) => checks?.has(checkKey(ref, c.child_id))).length
    : 0

  // What the tap means right now. During the block it is "here"; from half an
  // hour before it ends the question stops being who is present and becomes
  // where each of them goes — which is when the destination groups start
  // earning their place. One word, changed everywhere at once, so the two
  // meanings are never on screen together.
  const end = toMinutes(block.end_time)
  const routing =
    isToday && end !== null && minutesNow() >= end - 30 && block.kind === 'class'
  const verb = routing ? 'routed' : 'here'

  const chained = block.children.filter((c) => c.chained || c.from_class).length

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-3">
      <Card className="p-3.5 md:p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-[1.35rem] font-extrabold tracking-tight text-ink-900 md:text-[1.55rem]">
            {block.title}
          </h2>
          <p className="text-[0.9rem] font-bold text-ink-500">
            {clock(block.start_time)}–{clock(block.end_time)}
            {block.location && ` · ${block.location}`}
            {block.kind === 'care' && ' · Care'}
            {block.with.length > 0 &&
              ` · with ${block.with.map((w) => w.name).join(', ')}`}
          </p>
        </div>

        {expected.length > 0 && (
          <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="text-[0.98rem] font-extrabold whitespace-nowrap text-ink-900">
              {done} of {expected.length}{' '}
              <span className="font-bold text-ink-500">{verb}</span>
            </p>
            <div className="h-2 min-w-16 flex-1 overflow-hidden rounded-full bg-canvas-200">
              <div
                className={`h-full rounded-full transition-[width] ${
                  done === expected.length ? 'bg-leaf-500' : 'bg-sky-500'
                }`}
                style={{ width: `${(done / expected.length) * 100}%` }}
              />
            </div>
            {chained > 0 && (
              <p className="text-[0.82rem] font-bold whitespace-nowrap text-ink-400">
                {chained} arriving from another activity
              </p>
            )}
          </div>
        )}
      </Card>

      {block.children.length === 0 ? (
        <Card className="p-5">
          <p className="text-[0.9rem] font-semibold text-ink-400">
            Nobody is in this block.
          </p>
        </Card>
      ) : (
        // The routing plan, side by side. `columns` rather than a grid so the
        // browser balances the group cards by height instead of leaving one
        // column short — the groups are wildly uneven (a group of 5 next to a
        // group of 1) and a fixed grid would strand half the screen.
        <div className="min-h-0 flex-1 lg:overflow-y-auto">
          <div className="md:columns-2 md:gap-4 xl:columns-3">
            {groups.map((g) => (
              <GroupCard
                key={g.id}
                group={g}
                blockRef={ref}
                checks={checks}
                verb={verb}
                onSet={(childIds, present) =>
                  ref && setChecks.mutate({ block: ref, childIds, present })
                }
              />
            ))}
          </div>
        </div>
      )}
    </section>
  )
}

function GroupCard({
  group,
  blockRef: ref,
  checks,
  verb,
  onSet,
}: {
  group: Group
  blockRef: BlockRef | null
  checks: Set<string> | undefined
  verb: string
  onSet: (childIds: number[], present: boolean) => void
}) {
  const [openAllergy, setOpenAllergy] = useState<number | null>(null)
  const expected = group.children.filter((c) => !c.absent)
  const isOn = (c: Child) => Boolean(ref && checks?.has(checkKey(ref, c.child_id)))
  const done = expected.filter(isOn).length
  const complete = expected.length > 0 && done === expected.length
  const withAllergy = group.children.filter((c) => hasAllergy(c.allergies)).length

  // A finished group recedes to one line so the eye lands on what is still
  // open — and so a big class fits: four groups at full height do not.
  if (complete) {
    return (
      <section className="mb-3.5 break-inside-avoid rounded-card border-s-4 border-s-leaf-500 bg-leaf-50 md:mb-4">
        <div className="flex items-center gap-2.5 p-3">
          <CircleCheckBig
            className="size-5 shrink-0 text-leaf-600"
            strokeWidth={2.4}
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[0.98rem] font-extrabold text-leaf-700">
              {group.name}
            </p>
            <p className="text-[0.8rem] font-bold text-leaf-700/85">
              {expected.length} of {expected.length} {verb}
            </p>
          </div>
          {/* The allergy marker survives the collapse. "Everyone is here" is
              exactly when a counselor stops reading this group, so it is the
              one fact the green state must not swallow. */}
          {withAllergy > 0 && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-berry-50 px-2 py-1 text-[0.8rem] font-extrabold text-berry-700">
              <TriangleAlert className="size-3.5" strokeWidth={2.4} />
              {withAllergy}
            </span>
          )}
          <button
            type="button"
            onClick={() => onSet(expected.map((c) => c.child_id), false)}
            className="min-h-11 shrink-0 rounded-full border-2 border-leaf-100 px-3.5 text-[0.82rem] font-extrabold text-leaf-700"
          >
            Undo
          </button>
        </div>
      </section>
    )
  }

  return (
    <section
      className={`mb-3.5 break-inside-avoid overflow-hidden rounded-card border-s-4 bg-white shadow-soft md:mb-4 ${
        group.kind === 'parents'
          ? 'border-s-leaf-500'
          : group.kind === 'next'
            ? 'border-s-sky-500'
            : group.kind === 'unknown'
              ? 'border-s-sun-500'
              : 'border-s-canvas-200'
      }`}
    >
      <div className="flex items-center gap-2.5 p-3">
        <div className="min-w-0 flex-1">
          <p className="text-[1.02rem] leading-tight font-extrabold tracking-tight text-ink-900">
            {group.name}
          </p>
          <p className="mt-0.5 text-[0.8rem] font-bold text-ink-400">
            {group.when}
          </p>
        </div>
        <span className="grid h-9 min-w-10 shrink-0 place-items-center rounded-xl bg-canvas-100 px-2 text-[0.92rem] font-extrabold text-ink-700">
          {done}/{expected.length}
        </span>
      </div>

      <ul>
        {group.children.map((child) => {
          const on = isOn(child)
          const allergies = hasAllergy(child.allergies)
            ? child.allergies!.trim()
            : undefined
          const open = openAllergy === child.child_id
          return (
            <li
              key={child.child_id}
              className={`border-t border-canvas-100 ${child.absent ? 'opacity-55' : ''}`}
            >
              <div className="flex items-center gap-2.5 py-1.5 ps-3 pe-3">
                <button
                  type="button"
                  disabled={child.absent || !ref}
                  aria-pressed={on}
                  aria-label={`${on ? 'Undo' : 'Mark'} ${child.name} ${verb}`}
                  onClick={() => onSet([child.child_id], !on)}
                  className={`grid size-12 shrink-0 place-items-center rounded-2xl border-2 transition-colors disabled:opacity-40 ${
                    on
                      ? 'border-leaf-500 bg-leaf-500 text-white'
                      : 'border-canvas-200 bg-white text-transparent'
                  }`}
                >
                  <Check className="size-6" strokeWidth={3} />
                </button>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-[1rem] leading-tight font-extrabold text-ink-900">
                    {child.name}
                  </p>
                  <p className="text-[0.86rem] leading-tight font-semibold text-ink-500">
                    {child.grade_label && `Gr ${child.grade_label}`}
                    {child.grade_label && child.school && ' · '}
                    {child.school}
                    {child.absent && (
                      <span className="font-extrabold text-berry-600">
                        {(child.grade_label || child.school) && ' · '}absent
                      </span>
                    )}
                  </p>
                </div>

                {/* Second-strongest field on the row, in its own column so the
                    times line up as a readable stripe. It was 12.5px grey
                    inline text, and it is what decides what happens next. */}
                <span className="shrink-0 text-[1rem] font-extrabold text-ink-900 tabular-nums">
                  {pickup(child.dismissal_time)}
                </span>
              </div>

              {/* Chained arrivals get a line rather than a chip beside the
                  name: the name truncates at the column edge, so a chip there
                  is the first thing to disappear — on the one child who needs
                  it. Rare enough that the row costs nothing. */}
              {(child.from_class || child.chained) && (
                <p className="mx-3 mb-2 flex items-center gap-1.5 rounded-xl bg-sky-50 px-2.5 py-1.5 text-[0.82rem] font-extrabold text-sky-700">
                  <ArrowRight className="size-4 shrink-0" strokeWidth={2.6} />
                  {child.from_class
                    ? `Arrives from ${child.from_class}`
                    : 'Continues from an earlier activity'}
                </p>
              )}
              {child.to_class && (
                <p className="mx-3 mb-2 flex items-center gap-1.5 rounded-xl bg-canvas-100 px-2.5 py-1.5 text-[0.82rem] font-bold text-ink-600">
                  <ArrowRight className="size-4 shrink-0" strokeWidth={2.6} />
                  Goes on to {child.to_class}
                </p>
              )}

              {/* Only a real allergy renders anything at all. */}
              {allergies && (
                <>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenAllergy(open ? null : child.child_id)}
                    className="mx-3 mb-2 flex min-h-12 w-[calc(100%-1.5rem)] items-center gap-2 rounded-xl bg-berry-50 px-3 text-start text-berry-700"
                  >
                    <TriangleAlert
                      className="size-5 shrink-0 text-berry-500"
                      strokeWidth={2.4}
                    />
                    <span className="truncate text-[0.9rem] font-extrabold tracking-wide uppercase">
                      {shortAllergy(allergies)}
                    </span>
                    <span className="ms-auto shrink-0 text-[0.76rem] font-bold opacity-80">
                      {open ? 'Hide' : 'Details'}
                    </span>
                  </button>
                  {open && (
                    <p className="mx-3 mb-2 rounded-xl border-2 border-berry-200 bg-berry-50 px-3 py-2.5 text-[0.88rem] leading-snug font-bold text-berry-700">
                      {allergies}
                    </p>
                  )}
                </>
              )}
            </li>
          )
        })}
      </ul>

      {expected.length > 0 && (
        <div className="p-3 pt-1.5">
          <button
            type="button"
            disabled={!ref}
            onClick={() => onSet(expected.map((c) => c.child_id), true)}
            className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-sky-50 px-4 text-[0.95rem] font-extrabold text-sky-700 disabled:opacity-40"
          >
            <Check className="size-5" strokeWidth={2.8} />
            {done > 0
              ? `${verb === 'routed' ? 'Route' : 'Confirm'} the other ${expected.length - done}`
              : `${verb === 'routed' ? 'Route' : 'Confirm'} all ${expected.length}`}
          </button>
        </div>
      )}
    </section>
  )
}

