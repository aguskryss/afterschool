import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  ArrowRight,
  CalendarOff,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  TriangleAlert,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Card, EmptyState, Pill, Skeleton } from '@/components/ui'

const BLOCK_LABEL: Record<string, string> = {
  '3-4': '3p – 4p',
  '4-5': '4p – 5p',
  '5-6': '5p – 6p',
}

type Person = { counselor_id: number; name: string | null; only_today: boolean }

type Child = {
  child_id: number
  name: string
  grade_label: string | null
  school: string | null
  dismissal_time: number | null
  allergies: string | null
  absent: boolean
  dismiss_to?: string | null
  dismiss_kind?: 'class' | 'parents' | 'care' | 'unknown'
  chained?: boolean
  partial?: boolean
  from_class?: string | null
  to_class?: string | null
}

type ClassBlock = {
  class_id: number
  name: string
  start_time: string | null
  end_time: string | null
  location: string | null
  capacity: number | null
  staff: Person[]
  children: Child[]
  present_count: number
}

type CareBlock = {
  time_block: string
  room_id: number
  room_name: string | null
  grade_label: string | null
  staff: Person[]
  children: Child[]
  present_count: number
  stood_down: (string | null)[]
}

type Warning = {
  code: string
  label?: string | null
  message?: string
  child_name?: string | null
  time_block?: string
}

type Board = {
  date: string
  day: string
  closed: boolean
  classes: ClassBlock[]
  care: CareBlock[]
  warnings: Warning[]
}

/** What each warning code is, said once, in the plural. */
const WARNING_TITLE: Record<string, string> = {
  no_dismissal_time: 'no pickup time on file, so there is no way to tell a waiting parent from a care room',
  class_without_end_time: 'in a class with no end time, so nothing downstream can be worked out',
  class_ends_after_dismissal: 'in a class that ends after they go home — handed to the parent, but check the hours',
  no_care_room_for_grade: 'in a grade with no care room for their block',
  child_without_grade: 'without a grade, so no care rule can place them',
  classes_overlap: 'booked into two classes at the same hour',
  class_without_staff: 'with nobody running them',
  room_without_staff: 'with children and nobody in them',
  class_over_capacity: 'over capacity',
}

/**
 * One line per KIND of problem, naming who it is about.
 *
 * The engine emits one warning per child, so twelve children with no pickup time
 * produced twelve identical sentences and not one of them said which child — the
 * banner was long enough to look thorough and useless to act on. Grouping puts
 * the count and the names in one line.
 */
function groupWarnings(warnings: Warning[]) {
  const byCode = new Map<string, string[]>()
  for (const w of warnings) {
    const who = w.child_name ?? w.label ?? null
    const list = byCode.get(w.code) ?? []
    if (who) list.push(who)
    byCode.set(w.code, list)
  }
  return [...byCode.entries()].map(([code, names]) => {
    const unique = [...new Set(names)]
    return {
      code,
      count: unique.length,
      names: unique,
      title: WARNING_TITLE[code] ?? code.replace(/_/g, ' '),
    }
  })
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

function clock(value: string | null): string {
  if (!value) return '—'
  const [h, m] = value.split(':').map(Number)
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`
}

/** The pickup hour as the sheets write it. Null is a gap, never six. */
function pickup(hour: number | null): string {
  return hour === null ? '—' : `${hour}p`
}

function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

/**
 * The two attendance sheets, generated instead of assembled.
 *
 * These are the pages the director builds by hand every afternoon — §3.5
 * `{Day} - Classes` and §3.6 `{Day} - Care` — with the block headers, the staff
 * lists, the rosters, the `Dismiss To` column, the From/To column and the bold.
 * Every one of those is derived from the same engine call the counselors' screens
 * read, so the board and their phones cannot disagree about one afternoon.
 *
 * The warnings sit at the top because that is the point of generating this:
 * a child with no computable destination and a room with nobody in it are
 * findable here in a second and invisible on paper.
 *
 * Print still works — it is a plain page — but nothing here is designed around
 * paper, because the counselor screens are what replaced the printing.
 */
export function AdminDailyBoard() {
  const [date, setDate] = useState(isoToday())
  const [tab, setTab] = useState<'classes' | 'care'>('classes')

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'daily-board', date],
    queryFn: () => api<Board>(`/api/admin/daily-board?date=${date}`),
  })

  const gaps = data?.warnings ?? []
  const grouped = groupWarnings(gaps)

  return (
    <div className="mx-auto w-full max-w-6xl">
      <h1 className="mb-2 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Daily board
      </h1>
      <p className="mb-5 max-w-3xl text-[0.95rem] font-medium text-ink-500">
        Both attendance sheets for one day, built from the classes, the care rules
        and the staff schedule. Nothing here is typed in.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label="Previous day"
          onClick={() => setDate((d) => shiftDate(d, -1))}
          className="rounded-full bg-white p-2 text-ink-500 shadow-soft hover:text-ink-800"
        >
          <ChevronLeft className="size-4" strokeWidth={2.6} />
        </button>
        <p className="text-[1rem] font-extrabold text-ink-800">
          {longDate(date)}
        </p>
        <button
          type="button"
          aria-label="Next day"
          onClick={() => setDate((d) => shiftDate(d, 1))}
          className="rounded-full bg-white p-2 text-ink-500 shadow-soft hover:text-ink-800"
        >
          <ChevronRight className="size-4" strokeWidth={2.6} />
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value || isoToday())}
          aria-label="Date"
          className="h-9 rounded-full border-2 border-canvas-200 bg-white px-3 text-[0.85rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
        />
        {date !== isoToday() && (
          <button
            type="button"
            onClick={() => setDate(isoToday())}
            className="text-[0.85rem] font-bold text-sky-600 hover:text-sky-700"
          >
            Today
          </button>
        )}
      </div>

      {gaps.length > 0 && (
        <Card className="mb-4 border-2 border-sun-200 bg-sun-50 p-4">
          <div className="flex items-start gap-3">
            <TriangleAlert
              className="mt-0.5 size-5 shrink-0 text-sun-600"
              strokeWidth={2.4}
            />
            <div className="min-w-0">
              <p className="font-extrabold text-sun-700">
                {grouped.length === 1
                  ? 'One thing needs attention'
                  : `${grouped.length} things need attention`}
              </p>
              <ul className="mt-1 flex flex-col gap-1 text-[0.88rem] font-semibold text-sun-700">
                {grouped.map((g) => (
                  <li key={g.code}>
                    <span className="font-extrabold">
                      {g.count > 0 ? `${g.count} ` : ''}
                    </span>
                    {g.title}
                    {g.names.length > 0 && (
                      <span className="text-sun-600">
                        {' — '}
                        {g.names.slice(0, 8).join(', ')}
                        {g.names.length > 8 && ` and ${g.names.length - 8} more`}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </Card>
      )}

      {isPending ? (
        <Skeleton className="h-72" />
      ) : !data ? null : data.closed ? (
        <EmptyState
          icon={<CalendarOff className="size-7" strokeWidth={1.8} />}
          title="The program does not run this day"
          body="Pick a weekday to see its sheets."
        />
      ) : (
        <>
          <div className="mb-4 flex gap-1 rounded-full bg-canvas-100 p-1 sm:w-fit">
            {(['classes', 'care'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                aria-current={t === tab ? 'true' : undefined}
                className={`h-9 flex-1 rounded-full px-5 text-[0.85rem] font-bold transition sm:flex-none ${
                  t === tab ? 'bg-white text-ink-800 shadow-soft' : 'text-ink-500'
                }`}
              >
                {data.day} – {t === 'classes' ? 'Classes' : 'Care'}
                <span className="ms-2 text-[0.75rem] text-ink-400">
                  {t === 'classes' ? data.classes.length : data.care.length}
                </span>
              </button>
            ))}
          </div>

          {tab === 'classes' ? (
            data.classes.length === 0 ? (
              <EmptyState
                icon={<CalendarOff className="size-7" strokeWidth={1.8} />}
                title="No classes this day"
              />
            ) : (
              <div className="flex flex-col gap-4">
                {data.classes.map((block) => (
                  <Sheet
                    key={block.class_id}
                    title={block.name}
                    detail={`${clock(block.start_time)}–${clock(block.end_time)}${
                      block.location ? ` · ${block.location}` : ''
                    }`}
                    staff={block.staff}
                    present={block.present_count}
                    capacity={block.capacity}
                    columns={['School', 'Name', 'Gr', 'Out', 'Dismiss to']}
                    rows={block.children}
                    kind="classes"
                  />
                ))}
              </div>
            )
          ) : data.care.length === 0 ? (
            <EmptyState
              icon={<CalendarOff className="size-7" strokeWidth={1.8} />}
              title="No care blocks this day"
              body="Set which grades wait in which room on the Care rooms screen."
            />
          ) : (
            <div className="flex flex-col gap-4">
              {data.care.map((block) => (
                <Sheet
                  key={`${block.time_block}-${block.room_id}`}
                  title={`${BLOCK_LABEL[block.time_block] ?? block.time_block} · ${
                    block.room_name
                  }${block.grade_label ? ` (${block.grade_label})` : ''}`}
                  detail="Care"
                  staff={block.staff}
                  standDown={block.stood_down}
                  present={block.present_count}
                  columns={['School', 'Name', 'Gr', 'From / to class', 'Out']}
                  rows={block.children}
                  kind="care"
                />
              ))}
            </div>
          )}

          <p className="mt-5 text-[0.8rem] font-medium text-ink-400">
            Underlined names are in the block for only part of the hour, because of
            a class. Absent children stay listed and are not counted.
          </p>
        </>
      )}
    </div>
  )
}

function Sheet({
  title,
  detail,
  staff,
  standDown,
  present,
  capacity,
  columns,
  rows,
  kind,
}: {
  title: string
  detail: string
  staff: Person[]
  standDown?: (string | null)[]
  present: number
  capacity?: number | null
  columns: string[]
  rows: Child[]
  kind: 'classes' | 'care'
}) {
  const over = capacity != null && present > capacity
  return (
    <Card className="overflow-hidden">
      {/* The sheet's own block header: what it is, when, where, and who runs it. */}
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 bg-canvas-100 px-4 py-3">
        <p className="text-[1.05rem] font-extrabold text-ink-900">{title}</p>
        <p className="text-[0.85rem] font-bold text-ink-500">{detail}</p>
        <p className="min-w-0 flex-1 text-[0.85rem] font-semibold text-ink-600">
          {staff.length === 0 ? (
            <span className="font-bold text-sun-700">Nobody assigned</span>
          ) : (
            staff.map((s, i) => (
              <span key={s.counselor_id}>
                {i > 0 && ', '}
                {s.name}
                {s.only_today && (
                  <span className="ms-1 text-[0.7rem] font-extrabold text-coral-700">
                    covering
                  </span>
                )}
              </span>
            ))
          )}
          {standDown && standDown.length > 0 && (
            <span className="ms-2 text-ink-400 line-through decoration-berry-500">
              {standDown.join(', ')}
            </span>
          )}
        </p>
        {over ? (
          <Pill status="berry">
            {present} of {capacity}
          </Pill>
        ) : (
          <span className="text-[0.8rem] font-bold text-ink-500">
            {present} {present === 1 ? 'child' : 'children'}
            {capacity != null && ` of ${capacity}`}
          </span>
        )}
      </div>

      {rows.length === 0 ? (
        <p className="px-4 py-4 text-[0.88rem] font-semibold text-ink-400">
          Nobody is in this block.
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[38rem] text-left text-[0.88rem]">
            <thead>
              <tr className="border-b border-canvas-200 text-[0.72rem] font-bold text-ink-400">
                {columns.map((c) => (
                  <th key={c} scope="col" className="px-4 py-2 font-bold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-canvas-200">
              {rows.map((child) => (
                <tr key={child.child_id} className={child.absent ? 'opacity-55' : ''}>
                  <td className="px-4 py-2 font-semibold text-ink-500">
                    {child.school ?? '—'}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`font-bold text-ink-900 ${
                        child.partial
                          ? 'underline decoration-sky-400 decoration-2'
                          : ''
                      }`}
                    >
                      {child.name}
                    </span>
                    {child.absent && (
                      <span className="ms-2">
                        <Pill status="berry">absent</Pill>
                      </span>
                    )}
                    {child.allergies && (
                      <span className="ms-2 inline-flex items-center gap-1 text-[0.78rem] font-bold text-berry-600">
                        <CircleAlert className="size-3" strokeWidth={2.6} />
                        {child.allergies}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 font-semibold text-ink-600">
                    {child.grade_label ?? '—'}
                  </td>
                  {kind === 'classes' ? (
                    <>
                      <td className="px-4 py-2 font-semibold text-ink-600">
                        {pickup(child.dismissal_time)}
                      </td>
                      <td className="px-4 py-2">
                        {child.dismiss_kind === 'unknown' ? (
                          <span className="font-bold text-sun-700">
                            no destination
                          </span>
                        ) : (
                          <span
                            className={`inline-flex items-center gap-1 font-bold ${
                              child.dismiss_kind === 'parents'
                                ? 'text-leaf-600'
                                : 'text-ink-800'
                            }`}
                          >
                            <ArrowRight
                              className="size-3.5 shrink-0 text-ink-400"
                              strokeWidth={2.6}
                            />
                            {child.dismiss_to}
                            {child.chained && ' **'}
                          </span>
                        )}
                      </td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-2 font-semibold text-ink-600">
                        {child.from_class || child.to_class ? (
                          <>
                            {child.from_class && `from ${child.from_class}`}
                            {child.from_class && child.to_class && ' · '}
                            {child.to_class && `to ${child.to_class}`}
                          </>
                        ) : (
                          <span className="text-ink-400">NO CLASS</span>
                        )}
                      </td>
                      <td className="px-4 py-2 font-semibold text-ink-600">
                        {pickup(child.dismissal_time)}
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  )
}
