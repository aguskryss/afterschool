import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import {
  Car,
  CircleCheckBig,
  Clock,
  Hand,
  School,
  TriangleAlert,
} from 'lucide-react'
import { api } from '@/lib/api'
import { hasModule } from '@/lib/auth'
import {
  hasAllergy,
  schoolProgress,
  shortAllergy,
  useAttendanceMarks,
  useRoster,
  type RosterChild,
  type RosterSchool,
} from '@/lib/roster'
import { usePickupStream, type Pickup } from '@/lib/usePickupStream'
import { Avatar, Button, Card, EmptyState, Skeleton } from '@/components/ui'
import { PushPrompt } from '@/components/PushPrompt'

type Marks = Parameters<typeof schoolProgress>[1]

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

function waitingFor(iso: string): string {
  const mins = Math.max(
    0,
    Math.round((Date.now() - new Date(iso).getTime()) / 60000),
  )
  if (mins < 1) return 'just now'
  return `${mins} min`
}

/* ── Live pickup queue ───────────────────────────────────────────────── */

/**
 * Full width and above everything, rather than a column inside the panel.
 *
 * A parent standing at the door outranks every other fact on this screen. It
 * renders nothing at all when the queue is empty, so the height it takes is
 * only ever spent on something that needs a person right now — which is what
 * lets it sit above the schools without costing them anything the rest of the
 * afternoon.
 */
function PickupQueue() {
  const { pickups } = usePickupStream()
  // Re-render once a minute so the "waiting 4 min" counters stay honest.
  const [, setTick] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 30_000)
    return () => clearInterval(t)
  }, [])

  const claim = useMutation({
    mutationFn: (id: number) =>
      api(`/api/pickups/${id}/claim`, { method: 'POST' }),
  })

  if (pickups.length === 0) return null

  return (
    <Card className="mb-3 overflow-hidden">
      <p className="flex items-center gap-2 bg-coral-50 px-4 py-2.5 text-[0.78rem] font-extrabold tracking-wide text-coral-700 uppercase">
        <Car className="size-4 shrink-0" strokeWidth={2.4} />
        {pickups.length} {pickups.length === 1 ? 'parent' : 'parents'} at the door
      </p>
      <ul className="divide-y divide-canvas-200 sm:grid sm:grid-cols-2 sm:divide-y-0 lg:grid-cols-3">
        {pickups.map((p: Pickup) => (
          <li key={p.id} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar name={p.child_name} id={p.child_id} />
            <div className="min-w-0 flex-1">
              <p className="truncate font-extrabold text-ink-900">
                {p.child_name}
              </p>
              {/* Wait time never truncates — it is what decides who goes out
                  first. The parent's name gives way instead. */}
              <p className="flex items-baseline gap-1.5 text-[0.85rem] font-medium text-ink-500">
                <span className="shrink-0 font-bold text-coral-600">
                  {waitingFor(p.created_at)}
                </span>
                <span className="truncate">· {p.parent_name}</span>
              </p>
            </div>
            <Button
              size="sm"
              variant="coral"
              className="shrink-0"
              loading={claim.isPending && claim.variables === p.id}
              onClick={() => claim.mutate(p.id)}
            >
              <Hand className="size-4" strokeWidth={2.4} />
              Got it
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/* ── Phases ──────────────────────────────────────────────────────────── */

type Phase = 'arrival' | 'building' | 'dismissal'

const PHASE_LABEL: Record<Phase, string> = {
  arrival: 'Arrival',
  building: 'In the building',
  dismissal: 'Dismissal',
}

const PHASE_JOB: Record<Phase, string> = {
  arrival: 'Who has been checked in.',
  building: 'Who is here right now.',
  dismissal: 'Who has gone home.',
}

/**
 * Which job the screen is for, derived from the roster rather than the clock.
 *
 * A hard-coded 2:45–3:30 arrival window would be one JCC's window. Every
 * organization runs its own hours — this is a platform, not one programme — so
 * the phase comes from what the data says is outstanding: children nobody has
 * answered for means arrival; everyone answered for and still here means the
 * programme is running; children leaving means dismissal.
 *
 * It is only a default. All three are one tap away, and the tap wins.
 */
function defaultPhase(schools: RosterSchool[], marks: Marks): Phase {
  let pending = 0
  let here = 0
  let gone = 0
  for (const s of schools) {
    const p = schoolProgress(s, marks)
    pending += p.pending.length
    here += p.here
    gone += p.gone
  }
  if (pending > 0) return 'arrival'
  if (gone > 0 && gone >= here) return 'dismissal'
  return 'building'
}

/* ── The screen ──────────────────────────────────────────────────────── */

/**
 * Today: the whole programme at a glance, and what needs a person.
 *
 * WHAT CHANGED
 *   It was a single column of ~200px school cards, so four of six schools fit
 *   and the rest sat below the fold on the one screen whose job is "is
 *   anything wrong right now". They are a grid now — every school visible
 *   without scrolling on a tablet, two-up on a phone.
 *
 * NEEDS A PERSON IS A ROW, NOT A RAIL
 *   It used to be a fixed 320px column squeezed down the side, which is
 *   barely wider than a phone — a school name or an allergy list either
 *   truncated with "…" or forced the whole page to scroll sideways-feeling
 *   narrow. It runs full width below the schools now, its three categories
 *   side by side on a wide screen, so a name gets the room to actually be
 *   read instead of guessed at.
 *
 * ONE DENOMINATOR, ALWAYS
 *   The old card could show "0 of 4 in the building", a half-filled bar and a
 *   "2 left" pill at the same time: three numbers implying three different
 *   totals. Here every phase counts a different numerator out of the SAME
 *   total — children scheduled today — the bar is literally that fraction, and
 *   the pill is another subset of the same total, named. Two numbers on this
 *   screen can no longer imply two different groups of children.
 */
export function CounselorToday() {
  const { data: roster, isPending } = useRoster()

  // The date the server decided on, so the heading, the marks and the list
  // cannot disagree about what day it is.
  const serverDate = roster?.[0]?.date
  const { data: marks } = useAttendanceMarks(serverDate)
  const [picked, setPicked] = useState<Phase | null>(null)

  const schools = useMemo(() => roster ?? [], [roster])
  const phase = picked ?? defaultPhase(schools, marks)

  const totals = useMemo(() => {
    let total = 0
    let answered = 0
    let here = 0
    let gone = 0
    for (const s of schools) {
      const p = schoolProgress(s, marks)
      total += p.total
      answered += p.total - p.pending.length
      here += p.here
      gone += p.gone
    }
    return { total, answered, here, gone }
  }, [schools, marks])

  const now = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <div className="px-4 pt-4 pb-6 md:px-6">
      <div className="flex flex-col">
        <PushPrompt />

        <header className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <div>
            <h1 className="text-[1.6rem] font-extrabold tracking-tight text-ink-900 lg:text-[1.9rem]">
              Today
            </h1>
            <p className="text-[0.88rem] font-semibold text-ink-400">
              {new Date(
                `${serverDate ?? isoToday()}T12:00:00`,
              ).toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
              })}
              {schools.length > 0 &&
                ` · ${schools.length} ${schools.length === 1 ? 'school' : 'schools'}`}
            </p>
          </div>
          {/* A counselor picks this up for fifteen seconds at a time. The first
              thing they need is what time it is now. */}
          <p className="ms-auto flex items-center gap-2 rounded-2xl bg-white px-4 py-2 shadow-soft">
            <Clock className="size-4 text-ink-400" strokeWidth={2.4} />
            <span className="text-[1.3rem] font-extrabold tracking-tight text-ink-900 tabular-nums">
              {now}
            </span>
          </p>
        </header>

        {/* Only for JCCs that run the announce-then-claim queue. */}
        {hasModule('pickups') && <PickupQueue />}

        {isPending ? (
          <Skeleton className="h-40" />
        ) : !schools.length ? (
          <Card>
            <EmptyState
              icon={<School className="size-7" strokeWidth={1.8} />}
              title="No schools assigned"
              body="An administrator needs to assign you to a school before rosters appear."
            />
          </Card>
        ) : (
          <div className="flex flex-col gap-5">
            <div className="flex min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div
                  className="flex gap-1 rounded-full bg-canvas-100 p-1"
                  role="group"
                  aria-label="Which part of the afternoon"
                >
                  {(Object.keys(PHASE_LABEL) as Phase[]).map((p) => (
                    <button
                      key={p}
                      type="button"
                      aria-pressed={phase === p}
                      onClick={() => setPicked(p)}
                      className={`min-h-11 rounded-full px-3.5 text-[0.88rem] font-extrabold transition-colors ${
                        phase === p
                          ? 'bg-white text-ink-900 shadow-soft'
                          : 'text-ink-500'
                      }`}
                    >
                      {PHASE_LABEL[p]}
                    </button>
                  ))}
                </div>
                <p className="text-[0.86rem] font-semibold text-ink-500">
                  {PHASE_JOB[phase]}
                </p>
              </div>

              <p className="text-[1.05rem] font-extrabold tracking-tight text-ink-900">
                <span className="tabular-nums">
                  {phase === 'arrival'
                    ? `${totals.answered} of ${totals.total} checked in`
                    : phase === 'building'
                      ? `${totals.here} of ${totals.total} in the building`
                      : `${totals.gone} of ${totals.total} gone home`}
                </span>
                <span className="ms-2 text-[0.85rem] font-semibold text-ink-400 tabular-nums">
                  {phase === 'arrival'
                    ? `· ${totals.total - totals.answered} still to answer for`
                    : phase === 'building'
                      ? `· ${totals.gone} already went home`
                      : `· ${totals.here} still here`}
                </span>
              </p>

              <div className="grid grid-cols-2 gap-3 lg:grid-cols-[repeat(auto-fill,minmax(15rem,1fr))]">
                {schools.map((school) => (
                  <SchoolCard
                    key={school.school_id}
                    school={school}
                    marks={marks}
                    phase={phase}
                  />
                ))}
              </div>
            </div>

            <ExceptionsPanel schools={schools} marks={marks} />
          </div>
        )}
      </div>
    </div>
  )
}

function SchoolCard({
  school,
  marks,
  phase,
}: {
  school: RosterSchool
  marks: Marks
  phase: Phase
}) {
  const { here, total, gone, pending, submitted } = schoolProgress(school, marks)
  const answered = total - pending.length

  // The numerator changes with the phase. The denominator never does.
  const value =
    phase === 'arrival' ? answered : phase === 'building' ? here : gone
  const metric =
    phase === 'arrival'
      ? 'checked in'
      : phase === 'building'
        ? 'in the building'
        : 'gone home'
  const pill =
    phase === 'arrival'
      ? pending.length > 0
        ? { text: `${pending.length} left`, tone: 'sun' as const }
        : { text: 'All in', tone: 'leaf' as const }
      : phase === 'building'
        ? gone > 0
          ? { text: `${gone} went home`, tone: 'ink' as const }
          : { text: 'All still here', tone: 'leaf' as const }
        : { text: `${here} still here`, tone: 'ink' as const }

  const action =
    phase === 'arrival'
      ? pending.length > 0
        ? `Check in ${pending.length}`
        : 'Review roster'
      : 'Open roster'

  return (
    <Card className="flex flex-col gap-2 p-3.5">
      {/* The name owns a line. Sharing it with the pill was cutting "Hillel
          Community Day" down to "Hillel Community …", and the name is the one
          thing a counselor is hunting for. */}
      <h3 className="truncate text-[1.05rem] font-extrabold tracking-tight text-ink-900">
        {school.school}
      </h3>

      {total === 0 ? (
        <p className="text-[0.88rem] font-semibold text-ink-400">
          Nobody scheduled for {school.day}
        </p>
      ) : (
        <>
          <p className="text-[0.95rem] font-bold text-ink-700">
            <b className="font-extrabold text-ink-900 tabular-nums">{value}</b>{' '}
            of <span className="tabular-nums">{total}</span> {metric}
          </p>
          <div className="flex items-center gap-2">
            <div className="h-2 min-w-8 flex-1 overflow-hidden rounded-full bg-canvas-200">
              <div
                className={`h-full rounded-full transition-[width] ${
                  submitted && phase === 'arrival' ? 'bg-leaf-500' : 'bg-sky-500'
                }`}
                style={{ width: `${(value / total) * 100}%` }}
              />
            </div>
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-[0.76rem] font-extrabold whitespace-nowrap ${
                pill.tone === 'sun'
                  ? 'bg-sun-50 text-sun-700'
                  : pill.tone === 'leaf'
                    ? 'bg-leaf-50 text-leaf-700'
                    : 'bg-canvas-100 text-ink-600'
              }`}
            >
              {pill.text}
            </span>
          </div>
        </>
      )}

      {/* A labelled action, not a bare chevron. On a touch screen a chevron
          says "something happens", not what. */}
      <Link
        to={`/today/${school.school_id}`}
        className="mt-auto flex min-h-12 items-center justify-center rounded-full bg-sky-50 px-3 text-center text-[0.9rem] font-extrabold text-sky-700 active:bg-sky-100"
      >
        {total === 0 ? 'Open roster' : action}
      </Link>
    </Card>
  )
}

/* ── Exceptions ──────────────────────────────────────────────────────── */

type Flagged = { child: RosterChild; school: string }

/**
 * Only what needs a person, never a full list.
 *
 * Everything here is derived from the roster the screen already holds — nothing
 * is invented, and nothing needs an endpoint that does not exist. "Not answered
 * for" is a child with no attendance row at all, which is exactly what Submit
 * closes out; absences come from the parent; and the allergy section is a
 * standing reference rather than an exception, because a nut allergy does not
 * stop being true when nothing else is wrong.
 *
 * A full-width row of cards, not a rail down the side: a rail can only ever be
 * as wide as the sidebar, which meant a school name or an allergy list either
 * truncated or wrapped into a column barely wider than a phone. Here each
 * category gets a real card, side by side on a wide screen, with room for the
 * whole name.
 */
function ExceptionsPanel({
  schools,
  marks,
}: {
  schools: RosterSchool[]
  marks: Marks
}) {
  const { pending, absent, allergic } = useMemo(() => {
    const pending: Flagged[] = []
    const absent: Flagged[] = []
    const allergic: Flagged[] = []
    for (const s of schools) {
      for (const c of schoolProgress(s, marks).pending) {
        pending.push({ child: c, school: s.school })
      }
      for (const c of s.absent) absent.push({ child: c, school: s.school })
      for (const c of s.attending) {
        if (hasAllergy(c.allergies)) allergic.push({ child: c, school: s.school })
      }
    }
    return { pending, absent, allergic }
  }, [schools, marks])

  return (
    <section aria-label="Needs a person" className="flex flex-col gap-2.5">
      <p className="text-[0.74rem] font-extrabold tracking-wider text-ink-400 uppercase">
        Needs a person
      </p>

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {pending.length === 0 ? (
          <Card className="flex items-center gap-2.5 bg-leaf-50 p-3.5">
            <CircleCheckBig
              className="size-5 shrink-0 text-leaf-600"
              strokeWidth={2.4}
            />
            <div className="min-w-0">
              <p className="text-[0.95rem] font-extrabold text-leaf-700">
                Everyone is accounted for
              </p>
              <p className="text-[0.82rem] font-semibold text-leaf-700/85">
                No child is missing an answer today.
              </p>
            </div>
          </Card>
        ) : (
          <ExcSection title="Not answered for" tone="sun" rows={pending} />
        )}

        {absent.length > 0 && (
          <ExcSection title="Reported absent" tone="ink" rows={absent} />
        )}

        {/* Red is only ever this. */}
        {allergic.length > 0 && <AllergySection rows={allergic} />}
      </div>
    </section>
  )
}

function ExcSection({
  title,
  tone,
  rows,
}: {
  title: string
  tone: 'sun' | 'ink'
  rows: Flagged[]
}) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 6)
  return (
    <section
      className={`overflow-hidden rounded-card border-s-4 bg-white shadow-soft ${
        tone === 'sun' ? 'border-s-sun-500' : 'border-s-canvas-200'
      }`}
    >
      <p className="flex items-center gap-2 px-3.5 pt-3 pb-1 text-[0.74rem] font-extrabold tracking-wider text-ink-400 uppercase">
        {tone === 'sun' && (
          <Clock className="size-4 shrink-0" strokeWidth={2.4} />
        )}
        {title}
        <span className="ms-auto grid h-6 min-w-6 place-items-center rounded-lg bg-canvas-100 px-1.5 text-[0.8rem] font-extrabold text-ink-600">
          {rows.length}
        </span>
      </p>
      <ul className="px-3.5 pt-1 pb-2">
        {shown.map(({ child, school }) => (
          <li
            key={child.id}
            className="border-t border-canvas-100 py-2 first:border-t-0"
          >
            <p className="text-[0.95rem] font-extrabold text-ink-900">
              {child.name}
            </p>
            <p className="text-[0.83rem] font-semibold text-ink-500">
              {school}
              {child.grade && ` · Gr ${child.grade}`}
            </p>
          </li>
        ))}
      </ul>
      {/* Never a silent cap: if the list is trimmed, it says by how much. */}
      {rows.length > shown.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="min-h-11 w-full px-3.5 pb-2 text-start text-[0.84rem] font-extrabold text-sky-700"
        >
          Show the other {rows.length - shown.length}
        </button>
      )}
    </section>
  )
}

function AllergySection({ rows }: { rows: Flagged[] }) {
  const [all, setAll] = useState(false)
  const shown = all ? rows : rows.slice(0, 6)
  return (
    <section className="overflow-hidden rounded-card border-s-4 border-s-berry-500 bg-white shadow-soft">
      <p className="flex items-center gap-2 px-3.5 pt-3 pb-1 text-[0.74rem] font-extrabold tracking-wider text-berry-600 uppercase">
        <TriangleAlert className="size-4 shrink-0" strokeWidth={2.4} />
        Allergy alerts today
        <span className="ms-auto grid h-6 min-w-6 place-items-center rounded-lg bg-berry-100 px-1.5 text-[0.8rem] font-extrabold text-berry-700">
          {rows.length}
        </span>
      </p>
      <ul className="px-3.5 pt-1 pb-2">
        {shown.map(({ child, school }) => (
          <li
            key={child.id}
            className="border-t border-berry-100 py-2 first:border-t-0"
          >
            <p className="text-[0.95rem] font-extrabold text-ink-900">
              {child.name}
            </p>
            <p className="text-[0.85rem] font-extrabold tracking-wide text-berry-600 uppercase">
              {shortAllergy(child.allergies!.trim())}
            </p>
            <p className="text-[0.8rem] font-semibold text-ink-500">
              {school}
              {child.grade && ` · Gr ${child.grade}`}
            </p>
          </li>
        ))}
      </ul>
      {rows.length > shown.length && (
        <button
          type="button"
          onClick={() => setAll(true)}
          className="min-h-11 w-full px-3.5 pb-2 text-start text-[0.84rem] font-extrabold text-berry-700"
        >
          Show the other {rows.length - shown.length}
        </button>
      )}
    </section>
  )
}
