import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  Check,
  ChevronLeft,
  CircleCheckBig,
  School,
  Users,
} from 'lucide-react'
import { isGone, type AttendanceMap } from '@/lib/attendance'
import {
  hhmm,
  schoolProgress,
  useAttendanceMarks,
  useMarkAttendance,
  useRoster,
  type RosterSchool,
} from '@/lib/roster'
import { Avatar, Button, Card, EmptyState, Pill, Skeleton } from '@/components/ui'
import { ChildStatusControl, childSubtitle } from '@/components/ChildStatus'

/* ── The list of children at one school ──────────────────────────────── */

function AttendanceList({
  school,
  marks,
}: {
  school: RosterSchool
  marks: AttendanceMap | undefined
}) {
  const date = school.date
  const mark = useMarkAttendance(date)

  if (school.attending.length === 0) {
    return (
      <Card className="mb-4">
        <EmptyState
          icon={<Users className="size-7" strokeWidth={1.8} />}
          title="Nobody scheduled"
          body={`No children are registered for ${school.day}.`}
        />
      </Card>
    )
  }

  return (
    <Card className="mb-4 overflow-hidden">
      <ul className="divide-y divide-canvas-200">
        {school.attending.map((child) => {
          const entry = marks?.[String(child.id)]
          const on = Boolean(entry?.on_bus)
          const times = school.times?.[String(child.id)]
          // From the attendance map rather than the module-gated times, so a
          // released child reads as gone at every JCC.
          const gone = isGone(entry)
          return (
            <li key={child.id} className="flex flex-wrap items-stretch">
              {/* The whole row is the target: thumb-sized, not a small checkbox. */}
              <button
                type="button"
                aria-pressed={on}
                disabled={gone}
                onClick={() => mark.mutate({ childId: child.id, present: !on })}
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
                  {/* No allergy flag here. Ticking a child onto the bus is not
                      a moment where allergies change anything, and a marker on
                      every second name turns into wallpaper — it belongs where
                      it is acted on: the day sheets and the pickup door. */}
                  <p
                    className={`truncate font-bold ${gone ? 'text-ink-400' : 'text-ink-900'}`}
                  >
                    {child.name}
                  </p>
                  <p className="truncate text-[0.82rem] font-medium text-ink-500">
                    {gone
                      ? times?.checked_out_at
                        ? `Picked up by parent ${hhmm(times.checked_out_at)}`
                        : 'Picked up by parent'
                      : times?.checked_in_at
                        ? `In at ${hhmm(times.checked_in_at)}`
                        : childSubtitle(child)}
                  </p>
                </div>
                {/* A green tick next to "picked up by parent" reads as
                    "present". Once a child has gone, the control becomes a
                    label. */}
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

              {/* Only for a child still in play. Once they have left with a
                  parent the day is closed for them, and the server refuses a
                  status change anyway. */}
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

      {school.absent.length > 0 && (
        <div className="border-t border-canvas-200 bg-canvas-50 px-4 py-3">
          <p className="mb-2 text-[0.74rem] font-extrabold tracking-wide text-ink-400 uppercase">
            Absent today
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
  )
}

/* ── One school's attendance, start to Submit ────────────────────────── */

/**
 * Taking attendance at a school gate.
 *
 * One school at a time, on purpose: a counselor standing outside Brown wants
 * Brown's forty names, not the two hundred that four schools add up to. There
 * is no Release button anywhere on this screen — this is the moment children
 * are collected *from* school, and the moment they go home with a parent is a
 * different one, on its own screen, with a signature attached.
 *
 * Submit does not replace the ticks; every tick is already saved as it is
 * tapped, which is what keeps a phone that dies halfway down the line from
 * losing the morning. What Submit adds is the end of the job: it records
 * "not on the bus" for whoever was never ticked, which is what turns a
 * half-marked school into an answered one.
 */
export function CounselorSchoolAttendance() {
  const { schoolId } = useParams()
  const navigate = useNavigate()
  const { data: roster, isPending } = useRoster()

  const school = roster?.find((s) => String(s.school_id) === schoolId)
  const date = school?.date
  const { data: marks } = useAttendanceMarks(date)
  const submit = useMarkAttendance(date)

  // Recording a whole school as "nobody came" is one tap away from recording
  // a whole school correctly, so that one case asks twice.
  const [confirming, setConfirming] = useState(false)

  if (isPending) {
    return (
      <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
        <Skeleton className="h-52" />
      </div>
    )
  }

  if (!school) {
    return (
      <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
        <Card>
          <EmptyState
            icon={<School className="size-7" strokeWidth={1.8} />}
            title="School not found"
            body="It isn't on your list for today."
            action={
              <Button variant="outline" onClick={() => navigate('/today')}>
                Back to schools
              </Button>
            }
          />
        </Card>
      </div>
    )
  }

  const { here, total, gone, pending, submitted } = schoolProgress(school, marks)

  const doSubmit = () => {
    if (submitted) {
      navigate('/today')
      return
    }
    // Nobody here *and* nobody gone home means not one child was ever marked
    // at this school today — the case where a stray tap would file "nobody
    // came" for the whole roster. A school whose children have already left
    // has plainly been worked, and is not asked twice.
    if (here === 0 && gone === 0 && !confirming) {
      setConfirming(true)
      return
    }
    submit.mutate(
      pending.map((c) => ({ childId: c.id, present: false })),
      { onSuccess: () => navigate('/today') },
    )
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <Link
        to="/today"
        className="mb-3 -ml-1 inline-flex items-center gap-1 text-[0.85rem] font-bold text-ink-500 transition-colors hover:text-ink-800"
      >
        <ChevronLeft className="size-4" strokeWidth={2.8} />
        All schools
      </Link>

      <header className="mb-4 flex items-center gap-3">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-500">
          <School className="size-5" strokeWidth={2.1} />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[1.5rem] font-extrabold tracking-tight text-ink-900">
            {school.school}
          </h1>
          <p className="text-[0.85rem] font-semibold text-ink-500">
            {here} of {total} checked in
            {gone > 0 && ` · ${gone} gone home`}
          </p>
        </div>
      </header>

      <p className="mb-3 px-1 text-[0.82rem] font-medium text-ink-400">
        Tap each child as they get on the bus. Every tap saves on its own —
        Submit closes the school out for the day.
      </p>

      <AttendanceList school={school} marks={marks} />

      {total > 0 && (
        // Sticks above the tab bar so the button is reachable at any point in a
        // forty-name list, rather than only at the bottom of the scroll.
        <div className="sticky bottom-[calc(4.25rem+env(safe-area-inset-bottom))] z-10">
          <Card className="border-2 border-canvas-200 p-3">
            {submitted ? (
              <>
                <p className="mb-2 flex items-center gap-2 text-[0.9rem] font-extrabold text-leaf-700">
                  <CircleCheckBig className="size-4" strokeWidth={2.6} />
                  Attendance submitted
                </p>
                <p className="mb-2.5 text-[0.82rem] font-semibold text-ink-500">
                  All {total} accounted for · {here} in the building
                </p>
                <Button variant="outline" full onClick={() => navigate('/today')}>
                  Back to schools
                </Button>
              </>
            ) : confirming ? (
              <>
                <p className="mb-1 text-[0.9rem] font-extrabold text-ink-900">
                  Nobody has been marked here today.
                </p>
                <p className="mb-2.5 text-[0.82rem] font-semibold text-ink-500">
                  Submitting records{' '}
                  {pending.length === 1
                    ? '1 child'
                    : `all ${pending.length} children`}{' '}
                  as not on the bus.
                </p>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    className="flex-1"
                    onClick={() => setConfirming(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    className="flex-1"
                    loading={submit.isPending}
                    onClick={doSubmit}
                  >
                    Submit anyway
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="mb-2.5 text-[0.85rem] font-semibold text-ink-500">
                  <span className="font-extrabold text-ink-900">{here}</span> on
                  the bus ·{' '}
                  <span className="font-extrabold text-ink-900">
                    {pending.length}
                  </span>{' '}
                  not marked yet
                </p>
                <Button full loading={submit.isPending} onClick={doSubmit}>
                  Submit attendance
                </Button>
              </>
            )}

            {submit.isError && (
              <p className="mt-2 text-[0.82rem] font-bold text-berry-600">
                Couldn't submit. Check your connection and try again.
              </p>
            )}
          </Card>
        </div>
      )}
    </div>
  )
}
