import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Baby, Mail, Pencil, Phone, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { confirmDelete, notifyError } from '@/lib/confirm'
import { DataTable, type Column } from '@/components/DataTable'
import { AddButton, AddChildForm } from '@/components/people'
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

type Day = { day: string; dismissal_time: number | null }

type Contact = {
  priority: number
  name: string
  phone: string | null
  email: string | null
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
      value: (c) =>
        c.contacts.length
          ? c.contacts.map((g) => g.name).join(', ')
          : c.parent_name,
      render: (c) => (
        <span className="flex flex-col gap-0.5 text-[0.85rem]">
          {(c.contacts.length
            ? c.contacts.map((g) => g.name)
            : [c.parent_name]
          ).map((n) => (
            <span key={n} className="font-semibold text-ink-700">
              {n}
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
  const [serviceType, setServiceType] = useState(child.service_type)
  const [allergies, setAllergies] = useState(child.allergies ?? '')
  const [notes, setNotes] = useState(child.notes ?? '')
  const [active, setActive] = useState(child.active)
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api(`/api/admin/children/${child.id}`, {
        method: 'PUT',
        body: {
          name: name.trim(),
          school_id: schoolId,
          service_type: serviceType.trim(),
          allergies,
          notes,
          active,
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
          label="Service type"
          value={serviceType}
          onChange={(e) => setServiceType(e.target.value)}
        />
        <Field
          label="Allergies"
          value={allergies}
          onChange={(e) => setAllergies(e.target.value)}
          hint="Shown to counselors on every roster."
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
        <p className="mt-1 text-[0.82rem] font-semibold text-sun-600">
          An inactive child drops off every roster and headcount, but their
          history stays intact — unlike Delete.
        </p>
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

  const map = byDay(c.days)
  const guardians = c.contacts.length
    ? c.contacts
    : [
        {
          priority: 1,
          name: c.parent_name,
          email: c.parent_email,
          phone: c.parent_phone,
        },
      ]

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
      {c.allergies && (
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
        <Section title="Weekly schedule">
          <div className="flex flex-col">
            {WEEKDAYS.map((d) => {
              const entry = map.get(d)
              return (
                <Row key={d} label={d}>
                  {entry ? (
                    dismissalLabel(entry.dismissal_time)
                  ) : (
                    <span className="font-medium text-ink-400">
                      Not attending
                    </span>
                  )}
                </Row>
              )
            })}
          </div>
        </Section>

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
          {/* Only contact 1 owns a portal login today, so this is the account
              an admin would go to for invitations or a password reset. */}
          <Link
            to="/parents"
            className="mt-4 inline-block text-[0.85rem] font-bold text-sky-600 hover:text-sky-700"
          >
            Open the parent account →
          </Link>
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
      </div>
    </div>
  )
}
