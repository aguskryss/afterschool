import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react'
import { api } from '@/lib/api'
import { WEEKDAYS, absenceOn, todayIso, type Child } from '@/lib/parent'
import { Avatar, Card, EmptyState, Skeleton, colorForId } from '@/components/ui'

type CalendarEvent = {
  id: number
  event_date: string
  event_type: string
  title: string
  description: string | null
}

const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']

function iso(y: number, m: number, d: number): string {
  return `${y}-${`${m + 1}`.padStart(2, '0')}-${`${d}`.padStart(2, '0')}`
}

/**
 * Month calendar that doubles as the absence tool.
 *
 * The old portal split this across three places — a "mark absent" modal, a
 * separate recurring-absence view, and a make-up screen — so a parent had to
 * know which one they wanted before they could see their own month. Here the
 * month is the interface: tap a day your child attends to toggle the absence.
 */
export function ParentCalendar() {
  const qc = useQueryClient()
  const now = new Date()
  const [year, setYear] = useState(now.getFullYear())
  const [month, setMonth] = useState(now.getMonth())
  const [childId, setChildId] = useState<number | null>(null)

  const { data: children, isPending } = useQuery({
    queryKey: ['parent', 'children'],
    queryFn: () => api<Child[]>('/api/parent/children'),
  })

  const { data: events } = useQuery({
    queryKey: ['parent', 'calendar'],
    queryFn: () => api<CalendarEvent[]>('/api/parent/calendar'),
  })

  const child = useMemo(
    () => children?.find((c) => c.id === (childId ?? children[0]?.id)),
    [children, childId],
  )

  const toggleAbsence = useMutation({
    mutationFn: ({ date, absent }: { date: string; absent: boolean }) =>
      api('/api/parent/absences', {
        method: absent ? 'POST' : 'DELETE',
        body: { child_id: child!.id, date },
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['parent'] }),
  })

  const eventsByDate = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>()
    for (const e of events ?? []) {
      const list = map.get(e.event_date) ?? []
      list.push(e)
      map.set(e.event_date, list)
    }
    return map
  }, [events])

  // Leading blanks so the 1st lands under its real weekday.
  const firstWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array<null>(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ]

  const monthLabel = new Date(year, month, 1).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })

  function step(delta: number) {
    const next = new Date(year, month + delta, 1)
    setYear(next.getFullYear())
    setMonth(next.getMonth())
  }

  if (isPending) {
    return (
      <div className="mx-auto w-full max-w-2xl px-5 pt-5">
        <Skeleton className="h-96" />
      </div>
    )
  }

  if (!children?.length || !child) {
    return (
      <div className="mx-auto w-full max-w-2xl px-5 pt-5">
        <Card>
          <EmptyState
            icon={<CalendarDays className="size-7" strokeWidth={1.8} />}
            title="Nothing to show yet"
            body="Once your child is added to the program their schedule appears here."
          />
        </Card>
      </div>
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <h1 className="mb-4 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Calendar
      </h1>

      {children.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {children.map((c) => {
            const on = c.id === child.id
            return (
              <button
                key={c.id}
                type="button"
                aria-pressed={on}
                onClick={() => setChildId(c.id)}
                className={`inline-flex items-center gap-2.5 rounded-full border-2 py-2 pr-4 pl-2.5 text-[0.92rem] font-bold transition ${
                  on
                    ? 'border-sky-500 bg-sky-50 text-sky-700'
                    : 'border-canvas-200 bg-white text-ink-400'
                }`}
              >
                <span className={on ? '' : 'opacity-45 grayscale'}>
                  <Avatar name={c.name} id={c.id} size="sm" />
                </span>
                {c.name.split(' ')[0]}
              </button>
            )
          })}
        </div>
      )}

      <Card className="mb-4 p-4">
        <div className="mb-3 flex items-center justify-between">
          <button
            type="button"
            aria-label="Previous month"
            onClick={() => step(-1)}
            className="flex size-9 items-center justify-center rounded-full text-ink-600 transition-colors hover:bg-canvas-100"
          >
            <ChevronLeft className="size-5" strokeWidth={2.4} />
          </button>
          <p className="font-extrabold text-ink-900">{monthLabel}</p>
          <button
            type="button"
            aria-label="Next month"
            onClick={() => step(1)}
            className="flex size-9 items-center justify-center rounded-full text-ink-600 transition-colors hover:bg-canvas-100"
          >
            <ChevronRight className="size-5" strokeWidth={2.4} />
          </button>
        </div>

        <div className="mb-1 grid grid-cols-7 gap-1">
          {DAY_INITIALS.map((d, i) => (
            <div
              key={i}
              className="py-1 text-center text-[0.7rem] font-extrabold text-ink-400"
            >
              {d}
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => {
            if (day === null) return <div key={`b${i}`} />
            const date = iso(year, month, day)
            const weekday = WEEKDAYS[new Date(year, month, day).getDay()]
            const attends = child.registered_days.includes(weekday)
            const absence = absenceOn(child, date)
            const absent = Boolean(absence)
            // Only one-off absences toggle off here; a recurring day has to be
            // undone through its rule, so tapping it must not silently no-op.
            const locked = absence?.kind === 'recurring'
            const isToday = date === todayIso()
            const hasEvent = eventsByDate.has(date)
            const past = date < todayIso()

            return (
              <button
                key={date}
                type="button"
                disabled={!attends || past || locked}
                aria-label={`${date}${absent ? ' — absent' : ''}`}
                aria-pressed={absent}
                onClick={() =>
                  toggleAbsence.mutate({ date, absent: !absent })
                }
                className={`relative flex aspect-square flex-col items-center justify-center rounded-xl text-[0.85rem] font-bold transition ${
                  absent
                    ? 'bg-berry-500 text-white'
                    : attends && !past
                      ? 'bg-leaf-50 text-leaf-600 hover:bg-leaf-100'
                      : attends
                        ? 'bg-canvas-100 text-ink-400'
                        : 'text-ink-300'
                } ${isToday ? 'ring-2 ring-sky-500 ring-inset' : ''}`}
              >
                {day}
                {hasEvent && (
                  <span
                    className={`absolute bottom-1.5 size-1 rounded-full ${
                      absent ? 'bg-white' : 'bg-sun-500'
                    }`}
                  />
                )}
              </button>
            )
          })}
        </div>

        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-2 border-t border-canvas-200 pt-3 text-[0.78rem] font-semibold text-ink-500">
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded-md bg-leaf-50 ring-1 ring-leaf-100 ring-inset" />
            Attending
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-3 rounded-md bg-berry-500" />
            Absent
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-1.5 rounded-full bg-sun-500" />
            Program event
          </span>
        </div>
      </Card>

      <p className="mb-4 px-1 text-[0.85rem] font-medium text-ink-500">
        Tap a green day to tell us{' '}
        <span
          className="font-bold"
          style={{ color: colorForId(child.id) }}
        >
          {child.name.split(' ')[0]}
        </span>{' '}
        won&apos;t be coming. Tap again to undo.
      </p>

      <h2 className="mb-3 px-1 text-[0.95rem] font-extrabold text-ink-700">
        Coming up
      </h2>
      {!events?.length ? (
        <Card>
          <EmptyState
            icon={<CalendarDays className="size-7" strokeWidth={1.8} />}
            title="No events scheduled"
            body="Program closures and special days will show up here."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-canvas-200">
            {events.map((e) => (
              <li key={e.id} className="flex items-start gap-3 px-4 py-3">
                <span className="flex size-10 shrink-0 flex-col items-center justify-center rounded-xl bg-sun-50 text-sun-600">
                  <span className="text-[0.62rem] font-extrabold uppercase">
                    {new Date(`${e.event_date}T12:00:00`).toLocaleDateString(
                      'en-US',
                      { month: 'short' },
                    )}
                  </span>
                  <span className="text-[0.9rem] leading-none font-extrabold">
                    {new Date(`${e.event_date}T12:00:00`).getDate()}
                  </span>
                </span>
                <div className="min-w-0">
                  <p className="font-bold text-ink-900">{e.title}</p>
                  {e.description && (
                    <p className="text-[0.85rem] font-medium text-ink-500">
                      {e.description}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
