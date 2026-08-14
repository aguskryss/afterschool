import { useState } from 'react'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  School,
  Users,
} from 'lucide-react'
import { isGone, isHere, STATUS_LABEL } from '@/lib/attendance'
import { useAttendanceMarks, useMarkAttendance, useRoster } from '@/lib/roster'
import { Avatar, Card, EmptyState, Pill, Skeleton } from '@/components/ui'
import { ChildStatusControl, childSubtitle } from '@/components/ChildStatus'

function toIso(d: Date): string {
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

function shift(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number)
  // Build in local time and step by date parts, so a DST boundary can't
  // silently land us on the same day twice.
  const next = new Date(y, m - 1, d + days)
  return toIso(next)
}

/**
 * Roster for any date, not just today.
 *
 * Today's screen answers "who is here right now"; this one is for looking
 * ahead or back — checking who a substitute will have on Thursday, or what
 * yesterday's attendance ended up being.
 */
export function CounselorRoster() {
  // null until the server tells us what day the program is having. Seeding
  // this from the device's clock would start the stepper on the wrong date
  // for a phone in another timezone, and every step from there inherits it.
  const [picked, setPicked] = useState<string | null>(null)

  const { data: roster, isPending } = useRoster(picked ?? undefined)

  // The server echoes the date it resolved, so once the first response lands
  // the stepper walks from the program's day rather than the device's.
  const date = picked ?? roster?.[0]?.date ?? toIso(new Date())
  const setDate = (next: string | ((d: string) => string)) =>
    setPicked(typeof next === 'function' ? next(date) : next)

  const { data: marks } = useAttendanceMarks(date)
  const mark = useMarkAttendance(date)

  // "Today" is whatever day the program is having, not the device's.
  const isToday = picked === null || picked === roster?.[0]?.date
  const label = new Date(`${date}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <h1 className="mb-4 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Roster
      </h1>

      <Card className="mb-5 flex items-center justify-between gap-2 p-2">
        <button
          type="button"
          aria-label="Previous day"
          onClick={() => setDate((d) => shift(d, -1))}
          className="flex size-10 items-center justify-center rounded-full text-ink-600 transition-colors hover:bg-canvas-100"
        >
          <ChevronLeft className="size-5" strokeWidth={2.4} />
        </button>
        <div className="text-center">
          <p className="font-extrabold text-ink-900">{label}</p>
          {isToday && (
            <p className="text-[0.75rem] font-bold text-sky-500">Today</p>
          )}
        </div>
        <button
          type="button"
          aria-label="Next day"
          onClick={() => setDate((d) => shift(d, 1))}
          className="flex size-10 items-center justify-center rounded-full text-ink-600 transition-colors hover:bg-canvas-100"
        >
          <ChevronRight className="size-5" strokeWidth={2.4} />
        </button>
      </Card>

      {isPending ? (
        <Skeleton className="h-52" />
      ) : !roster?.length ? (
        <Card>
          <EmptyState
            icon={<School className="size-7" strokeWidth={1.8} />}
            title="No schools assigned"
            body="An administrator needs to assign you to a school before rosters appear."
          />
        </Card>
      ) : (
        roster.map((school) => (
          <Card key={school.school_id} className="mb-4 overflow-hidden">
            <div className="flex items-center gap-3 border-b border-canvas-200 px-4 py-3.5">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-500">
                <School className="size-5" strokeWidth={2.1} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-extrabold text-ink-900">
                  {school.school}
                </p>
                <p className="text-[0.85rem] font-semibold text-ink-500">
                  {/* Children who have gone home with a parent are not "in",
                      which this line used to count them as. */}
                  {
                    school.attending.filter((c) =>
                      isHere(marks?.[String(c.id)]),
                    ).length
                  }{' '}
                  of {school.attending.length} in the building
                </p>
              </div>
            </div>

            {school.attending.length === 0 ? (
              <EmptyState
                icon={<Users className="size-7" strokeWidth={1.8} />}
                title="Nobody scheduled"
                body={`No children are registered for ${school.day}.`}
              />
            ) : (
              <ul className="divide-y divide-canvas-200">
                {school.attending.map((child) => {
                  const entry = marks?.[String(child.id)]
                  const on = Boolean(entry?.on_bus)
                  const gone = isGone(entry)
                  return (
                    <li key={child.id} className="flex flex-wrap items-stretch">
                      <button
                        type="button"
                        aria-pressed={on}
                        // A child released to a parent is done for the day.
                        // Re-tapping them here can only produce a wrong
                        // answer, so the row stops being a control.
                        disabled={gone}
                        onClick={() =>
                          mark.mutate({ childId: child.id, present: !on })
                        }
                        className={`flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left transition-colors ${
                          gone
                            ? 'bg-canvas-50'
                            : on
                              ? 'bg-leaf-50'
                              : 'hover:bg-canvas-100'
                        }`}
                      >
                        <Avatar name={child.name} id={child.id} />
                        <div className="min-w-0 flex-1">
                          {/* No allergy flag on a check-in list — see the note
                              in SchoolAttendance. */}
                          <p
                            className={`truncate font-bold ${
                              gone ? 'text-ink-500' : 'text-ink-900'
                            }`}
                          >
                            {child.name}
                          </p>
                          <p className="truncate text-[0.82rem] font-medium text-ink-500">
                            {gone
                              ? STATUS_LABEL.checked_out
                              : childSubtitle(child)}
                          </p>
                        </div>
                        {gone ? (
                          <Pill status="neutral">Gone</Pill>
                        ) : (
                          <span
                            className={`flex size-8 shrink-0 items-center justify-center rounded-full border-2 transition ${
                              on
                                ? 'border-leaf-500 bg-leaf-500 text-white'
                                : 'border-canvas-200 text-transparent'
                            }`}
                          >
                            <Check className="size-4" strokeWidth={3.5} />
                          </span>
                        )}
                      </button>
                      {!gone && (
                        <ChildStatusControl
                          childId={child.id}
                          childName={child.name}
                          date={date}
                          mark={entry}
                        />
                      )}
                    </li>
                  )
                })}
              </ul>
            )}

            {school.absent.length > 0 && (
              <div className="border-t border-canvas-200 bg-canvas-50 px-4 py-3">
                <p className="mb-2 text-[0.74rem] font-extrabold tracking-wide text-ink-400 uppercase">
                  Absent
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {school.absent.map((c) => (
                    <span
                      key={c.id}
                      className="rounded-full bg-berry-50 px-2.5 py-1 text-xs font-bold text-berry-600"
                    >
                      {c.name}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </Card>
        ))
      )}
    </div>
  )
}
