import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import {
  ArrowLeft,
  Baby,
  Lock,
  Mail,
  Pencil,
  Phone,
  Plus,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { hasModule } from '@/lib/auth'
import { confirmAction, confirmDelete, notifyError } from '@/lib/confirm'
import { hasAllergy } from '@/lib/roster'
import { DataTable, type Column } from '@/components/DataTable'
import {
  AddButton,
  AddChildForm,
  ChildExtraFields,
  type ChildExtra,
} from '@/components/people'
import { Avatar, Button, Card, EmptyState, Field, Pill, Skeleton } from '@/components/ui'
import {
  STATUS_LABEL,
  STATUS_TONE,
  type ChildStatus,
} from '@/lib/attendance'

/* ── Shared types and formatting ─────────────────────────────────────── */

const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
] as const

/** Single letters for the compact strip. R is Thursday, as on the roster. */
const INITIALS: Record<string, string> = {
  Monday: 'M',
  Tuesday: 'T',
  Wednesday: 'W',
  Thursday: 'R',
  Friday: 'F',
}

type DayClass = {
  id: number
  name: string
  start_time: string | null
  end_time: string | null
}

type DayCare = {
  time_block: string
  room_id: number | null
  room_name: string | null
}

type Day = {
  day: string
  dismissal_time: number | null
  /** From class_enrollments — editable here. */
  classes: DayClass[]
  /**
   * Never stored per child — computed live from grade against the rules in
   * Care Rooms, the same way daily_routing works out anyone else's
   * afternoon. Shown for context; not editable from this screen. See the
   * conversation this came out of: overriding it per child would break the
   * one guarantee that makes a care room trustworthy — that it always comes
   * from the grade, never from a one-off click.
   */
  care: DayCare[]
}

/** How the Care Rooms screen writes the same three blocks. */
const TIME_BLOCK_LABEL: Record<string, string> = {
  '3-4': '3p–4p',
  '4-5': '4p–5p',
  '5-6': '5p–6p',
}

type Contact = {
  priority: number
  name: string
  phone: string | null
  email: string | null
  /** Set once Contact #2 has been linked to a portal login — see
   * server/database.py's comment on child_contacts. Always null for
   * Contact #1, whose account is children.parent_id, not this column. */
  user_id: number | null
  password_set: boolean | null
  invited_at: string | null
  last_login_at: string | null
}

type Child = {
  id: number
  name: string
  first_name: string | null
  last_name: string | null
  grade_label: string | null
  grade_num: number | null
  active: boolean
  service_type: string
  arrival_mode: 'bus' | 'dropoff' | null
  bus_rider: boolean | null
  allergies: string | null
  withdrawn_at: string | null
  withdrawn_reason: string | null
  school_id: number
  school: string
  parent_id: number
  parent_name: string
  parent_email: string
  days: Day[]
  contacts: Contact[]
  status: Status
}

/**
 * Every guardian on file, Contact #1 always included.
 *
 * `contacts` comes straight from child_contacts, which only has both rows
 * for a roster-imported child — one added by hand starts with none at all,
 * and can pick up a priority-2 row (via "Add a second guardian") with no
 * priority-1 row ever existing. Contact #1 is synthesized from
 * parent_name/parent_email/parent_phone whenever child_contacts doesn't
 * carry it, rather than only when the list is empty, so it never drops out
 * just because Contact #2 showed up.
 */
function guardianList(c: Child & { parent_phone?: string | null }): Contact[] {
  if (c.contacts.some((g) => g.priority === 1)) return c.contacts
  return [
    {
      priority: 1,
      name: c.parent_name,
      email: c.parent_email,
      phone: c.parent_phone ?? null,
      user_id: null,
      password_set: null,
      invited_at: null,
      last_login_at: null,
    },
    ...c.contacts,
  ]
}

/**
 * What a counselor recorded, plus the three the roster derives on its own.
 * The first six are the same words the counselor's screen uses — they were
 * different once (`in_building` here, `picked_up` there) and two names for
 * one state is how the meanings come apart.
 */
type Status =
  | ChildStatus
  | 'expected'
  | 'not_scheduled'
  | 'inactive'

const LABELS: Record<Status, string> = {
  ...STATUS_LABEL,
  expected: 'Expected',
  not_scheduled: 'Not in today',
  inactive: 'Inactive',
}

const TONES: Record<Status, 'leaf' | 'sun' | 'berry' | 'coral' | 'neutral'> = {
  ...STATUS_TONE,
  expected: 'neutral',
  not_scheduled: 'neutral',
  inactive: 'berry',
}

/**
 * Dismissal times are stored as the hour alone — the program runs exactly four
 * of them (3, 4, 5 and 6pm) and the schema says so with a CHECK. They are all
 * afternoon, so the PM is safe to hard-code.
 */
function dismissalLabel(hour: number | null): string {
  return hour === null ? 'Enrolled' : `${hour}:00 PM`
}

/** "16:45" as "4:45p" — how the sheets have always written it. */
function clock(value: string | null): string {
  if (!value) return '—'
  const [h, m] = value.split(':').map(Number)
  const hour = h % 12 === 0 ? 12 : h % 12
  return `${hour}:${String(m).padStart(2, '0')}${h < 12 ? 'a' : 'p'}`
}

/** The roster's own name order, which is how Heather reads her file. */
function sortName(c: Child): string {
  return c.last_name && c.first_name
    ? `${c.last_name}, ${c.first_name}`
    : c.name
}

function byDay(days: Day[]): Map<string, Day> {
  return new Map(days.map((d) => [d.day, d]))
}

/* ── The week strip ──────────────────────────────────────────────────── */

/**
 * Five slots, always five, so the eye can compare two rows without reading.
 * A blank weekday is a dash rather than nothing: "not enrolled Tuesday" and
 * "we have no data for Tuesday" look identical otherwise, and the first is a
 * fact about the child while the second would be a bug.
 */
function WeekStrip({ days }: { days: Day[] }) {
  const map = byDay(days)
  if (days.length === 0) {
    return <Pill status="sun">No days enrolled</Pill>
  }
  return (
    <span className="flex gap-1">
      {WEEKDAYS.map((d) => {
        const entry = map.get(d)
        return (
          <span
            key={d}
            title={
              entry
                ? `${d} — ${dismissalLabel(entry.dismissal_time)}`
                : `${d} — not attending`
            }
            className={`flex w-9 flex-col items-center rounded-lg px-1 py-1 text-[0.68rem] leading-tight font-bold ${
              entry
                ? 'bg-sky-50 text-sky-700'
                : 'bg-canvas-100 text-ink-400'
            }`}
          >
            <span>{INITIALS[d]}</span>
            <span className="font-extrabold">
              {entry ? (entry.dismissal_time ?? '✓') : '—'}
            </span>
          </span>
        )
      })}
    </span>
  )
}

/* ── The list ────────────────────────────────────────────────────────── */

type School = { id: number; name: string }
type ChildrenResponse = { date: string; day: string; children: Child[] }

const FILTER_SELECT =
  'h-10 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-semibold text-ink-800 outline-none focus:border-sky-500'

export function AdminChildren() {
  const navigate = useNavigate()
  const [school, setSchool] = useState('')
  const [day, setDay] = useState('')
  const [active, setActive] = useState('1')
  const [adding, setAdding] = useState(false)
  const [notesFor, setNotesFor] = useState<{ id: number; name: string } | null>(null)

  const { data: schools } = useQuery({
    queryKey: ['admin', 'schools'],
    queryFn: () => api<School[]>('/api/admin/schools'),
  })

  const { data: parents } = useQuery({
    queryKey: ['admin', 'parents'],
    queryFn: () => api<{ id: number; name: string; email: string }[]>('/api/admin/parents'),
  })

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'children', school, day, active],
    queryFn: () => {
      const params = new URLSearchParams()
      if (school) params.set('school_id', school)
      if (day) params.set('day', day)
      if (active !== 'all') params.set('active', active)
      const qs = params.toString()
      return api<ChildrenResponse>(
        `/api/admin/children${qs ? `?${qs}` : ''}`,
      )
    },
  })

  const columns: Column<Child>[] = [
    {
      key: 'name',
      header: 'Child',
      value: sortName,
      render: (c) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={c.name} id={c.id} size="sm" />
          <span className="font-bold text-ink-900">{c.name}</span>
        </span>
      ),
    },
    { key: 'school', header: 'School' },
    {
      key: 'grade_label',
      header: 'Grade',
      // Sort by the number so K lands before 1 and 10 after 9; show the
      // roster's own spelling, which is what staff recognise.
      value: (c) => c.grade_num ?? 99,
      render: (c) =>
        c.grade_label ?? <span className="text-ink-400">—</span>,
    },
    {
      key: 'days',
      header: 'Attendance days',
      // Sorting on the earliest dismissal hour is what "sort by dismissal
      // time" means for a child whose week has several of them.
      value: (c) => {
        const hours = c.days
          .map((d) => d.dismissal_time)
          .filter((h): h is number => h !== null)
        return hours.length ? Math.min(...hours) : 99
      },
      render: (c) => <WeekStrip days={c.days} />,
    },
    {
      key: 'guardians',
      header: 'Guardians',
      secondary: true,
      value: (c) => guardianList(c).map((g) => g.name).join(', '),
      render: (c) => (
        <span className="flex flex-col gap-0.5 text-[0.85rem]">
          {guardianList(c).map((g) => (
            <span key={g.priority} className="font-semibold text-ink-700">
              {g.name}
            </span>
          ))}
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      value: (c) => LABELS[c.status],
      render: (c) => (
        <Pill status={TONES[c.status]}>{LABELS[c.status]}</Pill>
      ),
    },
    {
      key: 'notes',
      header: '',
      align: 'right',
      value: () => '',
      render: (c) => (
        <button
          type="button"
          aria-label={`Private notes for ${c.name}`}
          // The row itself navigates to the profile (onRowClick below); this
          // button's whole point is opening notes without going there.
          onClick={(e) => {
            e.stopPropagation()
            setNotesFor({ id: c.id, name: c.name })
          }}
          className="flex size-9 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-sky-50 hover:text-sky-600"
        >
          <Lock className="size-4" strokeWidth={2.2} />
        </button>
      ),
    },
  ]

  const rows = data?.children
  const enrolled = rows?.filter((c) => c.days.length > 0).length ?? 0

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Children
      </h1>
      <p className="mb-6 text-[0.95rem] font-medium text-ink-500">
        {isPending
          ? 'Loading the roster…'
          : `${rows?.length ?? 0} shown · ${enrolled} enrolled on at least one day`}
      </p>

      {adding && (
        <AddChildForm
          parents={parents ?? []}
          schools={schools ?? []}
          onDone={() => setAdding(false)}
        />
      )}

      <DataTable
        rows={rows}
        columns={columns}
        loading={isPending}
        onRowClick={(c) => navigate(`/children/${c.id}`)}
        searchPlaceholder="Search children, schools or guardians…"
        emptyIcon={<Baby className="size-7" strokeWidth={1.8} />}
        emptyTitle="No children yet"
        emptyBody="Import the program from Import roster, or add one below."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={school}
              onChange={(e) => setSchool(e.target.value)}
              aria-label="Filter by school"
              className={FILTER_SELECT}
            >
              <option value="">All schools</option>
              {(schools ?? []).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <select
              value={day}
              onChange={(e) => setDay(e.target.value)}
              aria-label="Filter by attendance day"
              className={FILTER_SELECT}
            >
              <option value="">Any day</option>
              {WEEKDAYS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
            <select
              value={active}
              onChange={(e) => setActive(e.target.value)}
              aria-label="Filter by status"
              className={FILTER_SELECT}
            >
              <option value="1">Active</option>
              <option value="0">Inactive</option>
              <option value="all">Active and inactive</option>
            </select>
            <AddButton open={adding} onToggle={() => setAdding((v) => !v)}>
              {adding ? 'Cancel' : 'Add child'}
            </AddButton>
          </div>
        }
      />

      {notesFor && (
        <ChildNotesModal
          childId={notesFor.id}
          childName={notesFor.name}
          onClose={() => setNotesFor(null)}
        />
      )}
    </div>
  )
}

/* ── The profile ─────────────────────────────────────────────────────── */

type Compliance = {
  item: string
  status: string
  recorded_on: string | null
  raw_value: string | null
}

type Attendance = {
  attendance_date: string
  on_bus: boolean
  checked_in_at: string | null
  checked_out_at: string | null
  submitted_by_name: string | null
}

type ChildDetail = Child & {
  dob: string | null
  sex: string | null
  notes: string | null
  release_group: string | null
  created_at: string | null
  parent_phone: string | null
  compliance: Compliance[]
  recent_attendance: Attendance[]
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-canvas-200 py-2.5 last:border-0">
      <span className="text-[0.85rem] font-bold text-ink-500">{label}</span>
      <span className="text-right text-[0.9rem] font-semibold text-ink-900">
        {children}
      </span>
    </div>
  )
}

function Section({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-[1.05rem] font-extrabold text-ink-900">
        {title}
      </h2>
      {children}
    </Card>
  )
}

const NONE = <span className="font-medium text-ink-400">—</span>

/**
 * The fields worth fixing by hand: a typo in the name, a school the roster
 * import got wrong, allergies or notes that changed mid-year, or taking a
 * child out of service without erasing their attendance history (that's
 * `active`, not delete — delete is for a row that should never have
 * existed). Weekly schedule stays on the roster's own days-strip UI; this
 * form only touches columns days-attendance doesn't.
 */
function EditChildForm({
  child,
  schools,
  onClose,
}: {
  child: ChildDetail
  schools: School[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(child.name)
  const [schoolId, setSchoolId] = useState(child.school_id)
  const [extra, setExtra] = useState<ChildExtra>({
    service_type: child.service_type,
    grade_label: child.grade_label ?? '',
    dob: child.dob ? child.dob.slice(0, 10) : '',
    sex: child.sex ?? '',
    bus_rider: child.bus_rider ?? false,
    arrival_mode: child.arrival_mode ?? '',
  })
  const [allergies, setAllergies] = useState(child.allergies ?? '')
  const [notes, setNotes] = useState(child.notes ?? '')
  const [active, setActive] = useState(child.active)
  const [withdrawnReason, setWithdrawnReason] = useState(child.withdrawn_reason ?? '')
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api(`/api/admin/children/${child.id}`, {
        method: 'PUT',
        body: {
          name: name.trim(),
          school_id: schoolId,
          ...extra,
          allergies,
          notes,
          active,
          withdrawn_reason: withdrawnReason,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'child', String(child.id)] })
      void qc.invalidateQueries({ queryKey: ['admin', 'children'] })
      onClose()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not save that.'),
  })

  return (
    <Card className="mb-4 p-4">
      <p className="mb-3 font-extrabold text-ink-800">Edit child</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label className="flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
          School
          <select
            value={schoolId}
            onChange={(e) => setSchoolId(Number(e.target.value))}
            className="h-10 rounded-2xl border-2 border-canvas-200 bg-white px-3 text-[0.95rem] font-semibold text-ink-900 outline-none focus:border-sky-500"
          >
            {schools.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Allergies"
          value={allergies}
          onChange={(e) => setAllergies(e.target.value)}
          hint="Shown to counselors on every roster."
          className="sm:col-span-2"
        />
      </div>

      <label className="mt-3 flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
        Notes
        <textarea
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="rounded-2xl border-2 border-canvas-200 bg-white px-4 py-2.5 text-[0.9rem] font-medium text-ink-900 outline-none focus:border-sky-500"
        />
      </label>

      <div className="mt-3 border-t border-canvas-200 pt-3">
        <ChildExtraFields
          value={extra}
          onChange={(patch) => setExtra((v) => ({ ...v, ...patch }))}
        />
      </div>

      <label className="mt-3 flex items-center gap-2 text-[0.88rem] font-semibold text-ink-700">
        <input
          type="checkbox"
          checked={active}
          onChange={(e) => setActive(e.target.checked)}
          className="size-4 accent-sky-500"
        />
        Active in the program
      </label>
      {!active && (
        <>
          <p className="mt-1 mb-2 text-[0.82rem] font-semibold text-sun-600">
            An inactive child drops off every roster and headcount, but their
            history stays intact — unlike Delete.
          </p>
          <Field
            label="Reason (optional)"
            value={withdrawnReason}
            onChange={(e) => setWithdrawnReason(e.target.value)}
            placeholder="Moved, switched programs…"
          />
        </>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          disabled={!name.trim() || !schoolId}
          loading={save.isPending}
          onClick={() => save.mutate()}
        >
          Save
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

type ClassOption = {
  id: number
  name: string
  day_of_week: string
  start_time: string | null
  end_time: string | null
  active: boolean
}

/**
 * One day's classes and dismissal hour together, since Save writes both at
 * once. Classes: current ones as removable chips, plus a picker to add
 * another from that weekday's catalogue. More than one is a real case, not
 * an edge one — R3/R4 chain a child through back-to-back classes on the same
 * afternoon, so a single dropdown here would silently drop the second one
 * for anybody already living that. Dismissal hour: the roster import sets it
 * for most children, but a parent's mid-year request or an import mistake
 * needs a way to fix it by hand without re-running the whole import.
 */
function DayClassEditor({
  day,
  current,
  dismissalTime,
  saving,
  onSave,
  onCancel,
}: {
  day: string
  current: DayClass[]
  dismissalTime: number | null
  saving: boolean
  onSave: (classIds: number[], dismissalTime: number | null) => void
  onCancel: () => void
}) {
  const [ids, setIds] = useState<number[]>(current.map((c) => c.id))
  const [adding, setAdding] = useState('')
  const [hour, setHour] = useState<number | null>(dismissalTime)

  const { data: options } = useQuery({
    queryKey: ['admin', 'class-sessions', day],
    queryFn: () => api<ClassOption[]>(`/api/admin/class-sessions?day=${day}`),
  })

  const available = (options ?? []).filter((o) => !ids.includes(o.id))
  const byId = new Map((options ?? []).map((o) => [o.id, o]))
  // A class the child is in that fell out of the catalogue since (archived)
  // stays visible under its own name rather than turning into a bare number.
  const label = (id: number) =>
    byId.get(id)?.name ?? current.find((c) => c.id === id)?.name ?? `#${id}`

  return (
    <div className="mt-2 rounded-2xl bg-canvas-100 p-3">
      <label className="mb-2 flex items-center gap-2 text-[0.8rem] font-bold text-ink-600">
        Dismissal time
        <select
          value={hour ?? ''}
          onChange={(e) => setHour(e.target.value ? Number(e.target.value) : null)}
          aria-label={`Dismissal time on ${day}`}
          className="h-8 rounded-full border-2 border-canvas-200 bg-white px-3 text-[0.82rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
        >
          <option value="">Not set</option>
          <option value={3}>3:00 PM</option>
          <option value={4}>4:00 PM</option>
          <option value={5}>5:00 PM</option>
          <option value={6}>6:00 PM</option>
        </select>
      </label>

      <div className="mb-2 flex flex-wrap gap-1.5">
        {ids.length === 0 && (
          <span className="text-[0.82rem] font-medium text-ink-400">
            No class — care all afternoon
          </span>
        )}
        {ids.map((id) => (
          <span
            key={id}
            className="inline-flex items-center gap-1 rounded-full bg-white px-2.5 py-1 text-[0.78rem] font-bold text-ink-700 shadow-soft"
          >
            {label(id)}
            <button
              type="button"
              aria-label={`Remove ${label(id)}`}
              onClick={() => setIds((prev) => prev.filter((x) => x !== id))}
              className="text-ink-400 hover:text-berry-600"
            >
              <X className="size-3.5" strokeWidth={2.6} />
            </button>
          </span>
        ))}
      </div>

      {available.length > 0 ? (
        <select
          value={adding}
          onChange={(e) => {
            // Picking one adds it immediately — a second "confirm" step here
            // just reads as "I chose it, why didn't Save keep it".
            const id = Number(e.target.value)
            if (id) setIds((prev) => [...prev, id])
            setAdding('')
          }}
          aria-label={`Add a class on ${day}`}
          className="mb-2 h-9 w-full rounded-full border-2 border-canvas-200 bg-white px-3 text-[0.85rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
        >
          <option value="">Add a class…</option>
          {available.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
              {o.start_time && ` (${clock(o.start_time)}–${clock(o.end_time)})`}
            </option>
          ))}
        </select>
      ) : (
        options !== undefined && (
          <p className="mb-2 text-[0.8rem] font-medium text-ink-400">
            No other classes are set up for {day} yet — add one under Classes
            first.
          </p>
        )
      )}

      <div className="flex gap-2">
        <Button size="sm" loading={saving} onClick={() => onSave(ids, hour)}>
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

/**
 * Classes and dismissal time both come from class_enrollments/registrations
 * and are editable here, one day at a time. The care room never is — see the
 * note on `DayCare` above — it is shown as where the system would actually
 * send this child, not as a field with a dropdown next to it.
 *
 * Clearing a day's classes leaves the day itself registered — "No class,
 * care all afternoon" is a real, common schedule, not an empty one — so it
 * does not stop a care room from looking for them. Removing the day (the
 * trash icon) is the separate, stronger action for "not coming that day at
 * all": it drops the registrations row itself, the same way leaving a day
 * out of `days` does for `_sync_child_schedule` on the server, so nothing
 * downstream has a reason to expect them.
 */
function WeeklySchedule({ child }: { child: ChildDetail }) {
  const qc = useQueryClient()
  const [editingDay, setEditingDay] = useState<string | null>(null)
  const map = byDay(child.days)

  const save = useMutation({
    mutationFn: (
      days: {
        day: string
        class_session_ids: number[]
        dismissal_time?: number | null
      }[],
    ) => api(`/api/admin/children/${child.id}`, { method: 'PUT', body: { days } }),
    onSuccess: () => {
      setEditingDay(null)
      void qc.invalidateQueries({ queryKey: ['admin', 'child', String(child.id)] })
      void qc.invalidateQueries({ queryKey: ['admin', 'children'] })
    },
  })

  async function removeDay(day: string) {
    const ok = await confirmAction(
      `Stop bringing them on ${day}?`,
      `They come off ${day} entirely — no class, no care room, nobody looks for them at pickup. Other days are not affected.`,
      'Remove',
    )
    if (!ok) return
    save.mutate(
      child.days
        .filter((d) => d.day !== day)
        .map((d) => ({ day: d.day, class_session_ids: d.classes.map((c) => c.id) })),
    )
  }

  // Every currently-attending day travels along unchanged except the one
  // being saved — the endpoint treats a day missing from this list as "no
  // longer attending", so sending anything less would unenroll the rest.
  // `dismissal_time` is only sent for the day being saved: leaving the key
  // off the others is what tells the endpoint not to touch their hour.
  function saveDay(day: string, classIds: number[], dismissalTime: number | null) {
    save.mutate(
      child.days.map((d) =>
        d.day === day
          ? { day: d.day, class_session_ids: classIds, dismissal_time: dismissalTime }
          : { day: d.day, class_session_ids: d.classes.map((c) => c.id) },
      ),
    )
  }

  return (
    <Section title="Weekly schedule">
      <div className="flex flex-col">
        {WEEKDAYS.map((d) => {
          const entry = map.get(d)
          return (
            <div
              key={d}
              className="border-b border-canvas-200 py-2.5 last:border-0"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-[0.85rem] font-bold text-ink-500">
                  {d}
                </span>
                <span className="text-right text-[0.9rem] font-semibold text-ink-900">
                  {entry ? (
                    dismissalLabel(entry.dismissal_time)
                  ) : (
                    <span className="font-medium text-ink-400">
                      Not attending
                    </span>
                  )}
                </span>
              </div>

              {entry && editingDay !== d && (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {entry.classes.length === 0 ? (
                    <span className="text-[0.82rem] font-medium text-ink-400">
                      No class — care all afternoon
                    </span>
                  ) : (
                    entry.classes.map((cl) => (
                      <span
                        key={cl.id}
                        className="rounded-full bg-canvas-100 px-2.5 py-1 text-[0.78rem] font-bold text-ink-700"
                      >
                        {cl.name}
                        {cl.start_time &&
                          ` · ${clock(cl.start_time)}–${clock(cl.end_time)}`}
                      </span>
                    ))
                  )}
                  <button
                    type="button"
                    aria-label={`Edit ${d}'s schedule`}
                    onClick={() => setEditingDay(d)}
                    className="rounded-full p-1 text-ink-400 hover:bg-canvas-100 hover:text-ink-700"
                  >
                    <Pencil className="size-3.5" strokeWidth={2.4} />
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${d} entirely`}
                    disabled={save.isPending}
                    onClick={() => void removeDay(d)}
                    className="rounded-full p-1 text-ink-400 hover:bg-berry-50 hover:text-berry-500 disabled:opacity-40"
                  >
                    <Trash2 className="size-3.5" strokeWidth={2.4} />
                  </button>
                </div>
              )}

              {/* Where they'd actually wait, computed the same way Care Rooms
                  computes it for everyone else — never an editable field. */}
              {entry && entry.care.length > 0 && editingDay !== d && (
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[0.78rem] font-semibold text-ink-500">
                  {entry.care.map((c) => (
                    <span key={c.time_block}>
                      {TIME_BLOCK_LABEL[c.time_block] ?? c.time_block} →{' '}
                      {c.room_name ?? (
                        <span className="font-bold text-berry-600">
                          no room
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}

              {entry && editingDay === d && (
                <DayClassEditor
                  day={d}
                  current={entry.classes}
                  dismissalTime={entry.dismissal_time}
                  saving={save.isPending}
                  onSave={(ids, hour) => saveDay(d, ids, hour)}
                  onCancel={() => setEditingDay(null)}
                />
              )}
            </div>
          )
        })}
      </div>
      {save.isError && (
        <p className="mt-2 text-[0.82rem] font-semibold text-berry-600">
          {save.error instanceof ApiError
            ? save.error.message
            : 'Could not save that.'}
        </p>
      )}
    </Section>
  )
}

/* ── Private admin notes ─────────────────────────────────────────────── */

type ChildNote = {
  id: number
  author_name: string
  body: string
  created_at: string
}

function when(iso: string): string {
  const d = new Date(iso)
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 0) return `Today, ${time}`
  if (days === 1) return `Yesterday, ${time}`
  return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`
}

/**
 * The notes themselves, as a chat with yourself — every bubble is the admin
 * side because there's no other side. A running log rather than one editable
 * box: who wrote it and when matters as much as the text, the same reason
 * every other record in this app (an absence, a release, a staff message)
 * keeps who and when rather than just a current value. Backed by its own
 * table (child_notes), never `children.notes` — see
 * sql/53_add_child_notes.sql for why that distinction is the feature.
 *
 * No Card, no height here: the caller decides whether this sits inline on
 * the profile page or inside ChildNotesModal's floating frame.
 */
function ChildNotesThread({ childId }: { childId: number }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const endRef = useRef<HTMLDivElement>(null)
  const notesKey = ['admin', 'child', String(childId), 'notes']

  const { data: notes, isPending } = useQuery({
    queryKey: notesKey,
    queryFn: () => api<ChildNote[]>(`/api/admin/children/${childId}/notes`),
  })

  const add = useMutation({
    mutationFn: () =>
      api(`/api/admin/children/${childId}/notes`, {
        method: 'POST',
        body: { body },
      }),
    onSuccess: () => {
      setBody('')
      void qc.invalidateQueries({ queryKey: notesKey })
    },
    onError: (e) =>
      notifyError(
        'Could not save that note',
        e instanceof ApiError ? e.message : undefined,
      ),
  })

  const remove = useMutation({
    mutationFn: (noteId: number) =>
      api(`/api/admin/children/${childId}/notes/${noteId}`, {
        method: 'DELETE',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: notesKey }),
  })

  // The server hands back newest-first (the shape a future "recent notes
  // across every child" list would want); a chat reads oldest to newest with
  // the latest at the bottom, so this screen reverses it.
  const ordered = notes ? [...notes].slice().reverse() : []

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [ordered.length])

  return (
    <div className="flex h-full flex-col">
      <div className="mb-3 flex flex-1 flex-col gap-2 overflow-y-auto">
        {isPending ? (
          <Skeleton className="h-16" />
        ) : ordered.length === 0 ? (
          <EmptyState
            icon={<Lock className="size-7" strokeWidth={1.8} />}
            title="Nothing written yet"
            body="Whatever you write here stays between admins."
          />
        ) : (
          ordered.map((n) => (
            <div
              key={n.id}
              className="max-w-[85%] self-end rounded-3xl rounded-br-lg bg-sky-500 px-4 py-2.5 text-white"
            >
              <p className="text-[0.92rem] font-medium whitespace-pre-wrap">
                {n.body}
              </p>
              <p className="mt-1 flex items-center justify-end gap-1.5 text-[0.7rem] font-semibold text-white/70">
                {n.author_name} · {when(n.created_at)}
                <button
                  type="button"
                  aria-label="Delete note"
                  disabled={remove.isPending}
                  onClick={async () => {
                    if (await confirmDelete('this note')) remove.mutate(n.id)
                  }}
                  className="rounded-full p-1 transition-colors hover:bg-white/20 disabled:opacity-40"
                >
                  <Trash2 className="size-3" strokeWidth={2.4} />
                </button>
              </p>
            </div>
          ))
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (body.trim()) add.mutate()
        }}
        className="flex items-end gap-2"
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder="Add a note…"
          aria-label="Add a private note"
          className="min-w-0 flex-1 resize-none rounded-2xl border border-canvas-200 bg-white px-4 py-2.5 text-[0.9rem] font-medium text-ink-900 outline-none focus:border-sky-500"
        />
        <Button type="submit" loading={add.isPending} disabled={!body.trim()}>
          <Send className="size-4" strokeWidth={2.4} />
          Add
        </Button>
      </form>
    </div>
  )
}

/** The profile page's inline copy — same thread, in a Card instead of a
 * floating frame. */
function ChildNotes({ childId }: { childId: number }) {
  return (
    <Card className="flex h-[28rem] flex-col p-5">
      <div className="mb-1 flex items-center gap-2">
        <Lock className="size-4 text-ink-400" strokeWidth={2.2} />
        <h2 className="text-[1.05rem] font-extrabold text-ink-900">
          Private notes
        </h2>
      </div>
      <p className="mb-3 text-[0.8rem] font-medium text-ink-400">
        Only admins see this — never counselors or parents.
      </p>
      <ChildNotesThread childId={childId} />
    </Card>
  )
}

/**
 * The fast path from the Children list — opened by the lock icon after
 * Status, so seeing or adding a note never requires leaving the roster for a
 * child's full profile.
 */
function ChildNotesModal({
  childId,
  childName,
  onClose,
}: {
  childId: number
  childName: string
  onClose: () => void
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Private notes for ${childName}`}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/85 p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-4 right-4 flex size-10 items-center justify-center rounded-full bg-white/15 text-white"
      >
        <X className="size-5" strokeWidth={2.4} />
      </button>

      <div
        onClick={(e) => e.stopPropagation()}
        className="flex h-[32rem] w-full max-w-lg flex-col rounded-card bg-white p-5 shadow-lift"
      >
        <div className="mb-1 flex items-center gap-2">
          <Lock className="size-4 text-ink-400" strokeWidth={2.2} />
          <h2 className="truncate text-[1.05rem] font-extrabold text-ink-900">
            {childName}
          </h2>
        </div>
        <p className="mb-3 text-[0.8rem] font-medium text-ink-400">
          Only admins see this — never counselors or parents.
        </p>
        <ChildNotesThread childId={childId} />
      </div>
    </div>
  )
}

/* ── Approved for pickup ──────────────────────────────────────────────── */

type PickupPerson = {
  id: number | null
  name: string
  relationship: string | null
  is_parent: boolean
}

/**
 * Delete has always lived here — undoing a name that was added by mistake,
 * or is no longer approved. Add joined it for the case a parent's own app
 * can't cover yet: a child registered by hand before the parent has an
 * activated account, where someone still has to be authorized to collect
 * them on day one. Editing stays parent-only (their PATCH keeps every
 * sibling's copy of a name in sync; the office adds and removes instead of
 * renaming). The registered parent (`id` null, `is_parent`) never appears:
 * they can already collect without being on this list, so there's nothing
 * here to delete or add for them.
 */
function ApprovedPickups({ childId }: { childId: number }) {
  const qc = useQueryClient()
  const key = ['admin', 'child', String(childId), 'authorized-pickups']
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [relationship, setRelationship] = useState('')
  const [error, setError] = useState('')

  const { data, isPending } = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ people: PickupPerson[] }>(
        `/api/counselor/authorized-pickups?child_id=${childId}`,
      ),
  })

  const reset = () => {
    setName('')
    setRelationship('')
    setError('')
    setAdding(false)
  }

  const add = useMutation({
    mutationFn: () =>
      api('/api/admin/authorized-pickups', {
        method: 'POST',
        body: { child_id: childId, name, relationship },
      }),
    onSuccess: () => {
      reset()
      void qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not add that person.'),
  })

  const remove = useMutation({
    mutationFn: (personId: number) =>
      api(`/api/admin/authorized-pickups/${personId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
  })

  const people = (data?.people ?? []).filter((p) => !p.is_parent)

  return (
    <Section title="Approved for pickup">
      {isPending ? (
        <Skeleton className="h-16" />
      ) : people.length === 0 ? (
        <p className="text-[0.9rem] font-medium text-ink-500">
          Nobody added yet, besides the registered parent.
        </p>
      ) : (
        <ul className="mb-2 flex flex-col gap-2">
          {people.map((p) => (
            <li
              key={p.id}
              className="flex items-center justify-between gap-3 border-b border-canvas-200 pb-2 last:border-0 last:pb-0"
            >
              <span>
                <span className="font-bold text-ink-900">{p.name}</span>
                {p.relationship && (
                  <span className="ml-2 text-[0.82rem] font-medium text-ink-400">
                    {p.relationship}
                  </span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Remove ${p.name}`}
                disabled={remove.isPending}
                onClick={async () => {
                  if (p.id && (await confirmDelete(p.name))) remove.mutate(p.id)
                }}
                className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-berry-50 hover:text-berry-500 disabled:opacity-40"
              >
                <Trash2 className="size-3.5" strokeWidth={2.1} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {adding ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) add.mutate()
          }}
          className="mt-2 flex flex-col gap-2"
        >
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Grandma Ruth"
            autoFocus
          />
          <Field
            label="Relationship"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder="Grandmother"
          />
          {/* Same one-list-per-family rule as the parent app: this also
              authorizes every sibling of this child, not just this one. */}
          <p className="px-1 text-[0.78rem] font-medium text-ink-400">
            This also applies to the parent's other children, if any.
          </p>
          {error && (
            <p className="text-[0.82rem] font-semibold text-berry-600">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              loading={add.isPending}
              disabled={!name.trim()}
            >
              Add
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 rounded-2xl px-2 py-1.5 text-[0.82rem] font-bold text-ink-600 transition-colors hover:bg-canvas-100 active:bg-canvas-200"
        >
          <Plus className="size-4" strokeWidth={2.8} />
          Add someone
        </button>
      )}
    </Section>
  )
}

/**
 * Giving Contact #2 a portal login of their own, from the child's own
 * profile — the read side of this (their name/phone/email) has shown up
 * here for a while; this is the write side that was never built.
 *
 * Three states: no second guardian on file at all (roster import never saw
 * one, or the child was added by hand) → a form to add one; on file but not
 * linked → "Invite as parent"; linked → their own account status, with a
 * way to take the access back without deleting them as a contact.
 */
function SecondGuardianControls({
  childId,
  guardian,
}: {
  childId: number
  guardian: Contact | null
}) {
  const qc = useQueryClient()
  const key = ['admin', 'child', String(childId)]
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState('')
  const [phone, setPhone] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api(`/api/admin/children/${childId}/second-guardian`, {
        method: 'PUT',
        body: { name, phone, email },
      }),
    onSuccess: () => {
      setEditing(false)
      setError('')
      void qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not save that.'),
  })

  const invite = useMutation({
    mutationFn: () =>
      api<{ message: string }>(
        `/api/admin/children/${childId}/second-guardian/invite`,
        { method: 'POST' },
      ),
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: key })
      window.alert(result.message)
    },
    onError: (e) =>
      notifyError(
        'Could not invite',
        e instanceof ApiError ? e.message : undefined,
      ),
  })

  const removeAccess = useMutation({
    mutationFn: () =>
      api(`/api/admin/children/${childId}/second-guardian/access`, {
        method: 'DELETE',
      }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: key }),
    onError: (e) =>
      notifyError(
        'Could not remove access',
        e instanceof ApiError ? e.message : undefined,
      ),
  })

  if (!guardian) {
    if (!editing) {
      return (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="mt-3 flex items-center gap-1.5 rounded-2xl px-2 py-1.5 text-[0.82rem] font-bold text-ink-600 transition-colors hover:bg-canvas-100 active:bg-canvas-200"
        >
          <Plus className="size-4" strokeWidth={2.8} />
          Add a second guardian
        </button>
      )
    }
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) save.mutate()
        }}
        className="mt-3 flex flex-col gap-2"
      >
        <Field
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <Field
          label="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <Field
          label="Email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          hint="Needed to invite them as a parent."
        />
        {error && (
          <p className="text-[0.82rem] font-semibold text-berry-600">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button
            type="submit"
            size="sm"
            loading={save.isPending}
            disabled={!name.trim()}
          >
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setEditing(false)}
          >
            Cancel
          </Button>
        </div>
      </form>
    )
  }

  if (guardian.user_id) {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Pill status="leaf">Linked</Pill>
        <span className="text-[0.78rem] font-medium text-ink-400">
          {guardian.password_set
            ? 'Password set'
            : 'Invited, not signed in yet'}
          {guardian.last_login_at &&
            ` · last login ${new Date(guardian.last_login_at).toLocaleDateString()}`}
        </span>
        <Button
          size="sm"
          variant="outline"
          loading={removeAccess.isPending}
          onClick={() => removeAccess.mutate()}
        >
          <Trash2 className="size-3.5" strokeWidth={2.4} />
          Remove access
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-2">
      <Button size="sm" loading={invite.isPending} onClick={() => invite.mutate()}>
        <Send className="size-3.5" strokeWidth={2.6} />
        Invite as parent
      </Button>
    </div>
  )
}

export function AdminChildProfile() {
  const { id } = useParams()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const { data: c, isPending, isError } = useQuery({
    queryKey: ['admin', 'child', id],
    queryFn: () => api<ChildDetail>(`/api/admin/children/${id}`),
    enabled: Boolean(id),
  })
  const { data: schools } = useQuery({
    queryKey: ['admin', 'schools'],
    queryFn: () => api<School[]>('/api/admin/schools'),
  })

  const destroy = useMutation({
    mutationFn: () => api(`/api/admin/children/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'children'] })
      navigate('/children')
    },
    onError: (e) =>
      notifyError(
        'Could not delete that child',
        e instanceof ApiError ? e.message : undefined,
      ),
  })

  if (isPending) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <Skeleton className="h-24" />
        <Skeleton className="h-64" />
      </div>
    )
  }

  if (isError || !c) {
    return (
      <div className="mx-auto w-full max-w-4xl">
        <EmptyState
          icon={<Baby className="size-7" strokeWidth={1.8} />}
          title="Child not found"
          body="They may have been removed, or belong to another organization."
        />
      </div>
    )
  }

  const guardians = guardianList(c)
  const secondGuardian = guardians.find((g) => g.priority === 2) ?? null

  return (
    <div className="mx-auto w-full max-w-4xl">
      <Link
        to="/children"
        className="mb-4 inline-flex items-center gap-1.5 text-[0.9rem] font-bold text-ink-500 hover:text-ink-800"
      >
        <ArrowLeft className="size-4" strokeWidth={2.4} />
        All children
      </Link>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <Avatar name={c.name} id={c.id} size="lg" />
        <div className="min-w-0">
          <h1 className="text-[1.6rem] leading-tight font-extrabold tracking-tight text-ink-900">
            {c.name}
          </h1>
          <p className="text-[0.95rem] font-semibold text-ink-500">
            {c.school}
            {c.grade_label ? ` · Grade ${c.grade_label}` : ''}
          </p>
        </div>
        <div className="ms-auto flex items-center gap-2">
          <Pill status={TONES[c.status]}>{LABELS[c.status]}</Pill>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing((v) => !v)}
          >
            <Pencil className="size-3.5" strokeWidth={2.4} />
            {editing ? 'Cancel' : 'Edit'}
          </Button>
          <button
            type="button"
            aria-label={`Delete ${c.name}`}
            disabled={destroy.isPending}
            onClick={async () => {
              if (
                await confirmDelete(
                  c.name,
                  'This removes their whole attendance history too. Mark them inactive instead to just take them off the roster.',
                )
              )
                destroy.mutate()
            }}
            className="flex size-9 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-berry-50 hover:text-berry-500 disabled:opacity-40"
          >
            <Trash2 className="size-4" strokeWidth={2.1} />
          </button>
        </div>
      </div>

      {editing && (
        <EditChildForm
          child={c}
          schools={schools ?? []}
          onClose={() => setEditing(false)}
        />
      )}

      {/* Allergies are the one field that changes what a counselor does in the
          moment, so it sits above everything else rather than in a table. */}
      {hasAllergy(c.allergies) && (
        <Card className="mb-4 border-l-4 border-coral-500 bg-coral-50 p-4">
          <p className="text-[0.8rem] font-extrabold tracking-wide text-coral-700 uppercase">
            Allergies
          </p>
          <p className="font-bold text-ink-900">{c.allergies}</p>
        </Card>
      )}

      {!c.active && (
        <Card className="mb-4 bg-canvas-100 p-4">
          <p className="font-bold text-ink-800">
            No longer in the program
            {c.withdrawn_reason ? ` — ${c.withdrawn_reason}` : ''}
          </p>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <WeeklySchedule child={c} />

        <Section title="Guardians">
          <ul className="flex flex-col gap-3">
            {guardians.map((g) => (
              <li key={g.priority} className="flex flex-col gap-0.5">
                <span className="font-bold text-ink-900">
                  {g.name}
                  {guardians.length > 1 && (
                    <span className="ms-2 text-[0.75rem] font-bold text-ink-400">
                      Contact {g.priority}
                    </span>
                  )}
                </span>
                {g.email && (
                  <span className="flex items-center gap-1.5 text-[0.85rem] font-medium text-ink-600">
                    <Mail className="size-3.5" strokeWidth={2.2} />
                    {g.email}
                  </span>
                )}
                {g.phone && (
                  <span className="flex items-center gap-1.5 text-[0.85rem] font-medium text-ink-600">
                    <Phone className="size-3.5" strokeWidth={2.2} />
                    {g.phone}
                  </span>
                )}
              </li>
            ))}
          </ul>
          {/* Contact #1's account — the one children.parent_id has always
              pointed at. */}
          <Link
            to="/parents"
            className="mt-4 inline-block text-[0.85rem] font-bold text-sky-600 hover:text-sky-700"
          >
            Open the parent account →
          </Link>

          <div className="mt-4 border-t border-canvas-200 pt-3">
            <p className="text-[0.78rem] font-bold tracking-wide text-ink-400 uppercase">
              Second guardian's access
            </p>
            <SecondGuardianControls childId={c.id} guardian={secondGuardian} />
          </div>
        </Section>

        <Section title="Details">
          <div className="flex flex-col">
            <Row label="School">{c.school}</Row>
            <Row label="Grade">{c.grade_label ?? NONE}</Row>
            <Row label="Date of birth">{c.dob ?? NONE}</Row>
            <Row label="Sex">{c.sex ?? NONE}</Row>
            <Row label="Arrives by">
              {c.arrival_mode === 'bus'
                ? 'JCC bus'
                : c.arrival_mode === 'dropoff'
                  ? 'Parent drop-off'
                  : NONE}
            </Row>
            <Row label="Service">{c.service_type}</Row>
            {c.release_group && (
              <Row label="Release group">{c.release_group}</Row>
            )}
            <Row label="Notes">{c.notes ?? NONE}</Row>
          </div>
        </Section>

        <Section title="Recent attendance">
          {c.recent_attendance.length === 0 ? (
            <p className="text-[0.9rem] font-medium text-ink-500">
              Nothing recorded yet.
            </p>
          ) : (
            <div className="flex flex-col">
              {c.recent_attendance.map((a) => (
                <Row key={a.attendance_date} label={a.attendance_date}>
                  {a.checked_out_at
                    ? 'Picked up'
                    : a.on_bus
                      ? 'Present'
                      : 'Not marked'}
                </Row>
              ))}
            </div>
          )}
        </Section>

        {c.compliance.length > 0 && (
          <Section title="Paperwork">
            <div className="flex flex-col">
              {c.compliance.map((p) => (
                <Row key={p.item} label={p.item.replace(/_/g, ' ')}>
                  {p.raw_value || p.status}
                </Row>
              ))}
            </div>
          </Section>
        )}

        {hasModule('secure_pickup') && <ApprovedPickups childId={c.id} />}
      </div>

      <ChildNotes childId={c.id} />
    </div>
  )
}
