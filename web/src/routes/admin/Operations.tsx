import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, GraduationCap, School, UserRound } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { notifyError } from '@/lib/confirm'
import { matchesName } from '@/lib/roster'
import { DataTable, type Column } from '@/components/DataTable'
import { ExportButton } from '@/components/ExportButton'
import { AddButton, DeletePerson, EditPersonButton } from '@/components/people'
import { Avatar, Button, Card, Field, Pill, Skeleton } from '@/components/ui'

function toIso(d: Date): string {
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

/** Shared date picker header for the day-scoped operational views. */
function DayPicker({
  date,
  onChange,
  children,
}: {
  date: string
  onChange: (d: string) => void
  /** Extra controls for the right-hand side — the attendance view switcher. */
  children?: ReactNode
}) {
  return (
    <Card className="mb-4 flex flex-wrap items-center gap-3 p-3">
      <label
        htmlFor="ops-date"
        className="text-[0.85rem] font-bold text-ink-600"
      >
        Date
      </label>
      <input
        id="ops-date"
        type="date"
        value={date}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.92rem] font-medium text-ink-900 outline-none focus:border-sky-500"
      />
      <Button size="sm" variant="outline" onClick={() => onChange(toIso(new Date()))}>
        Today
      </Button>
      {children && <div className="ml-auto">{children}</div>}
    </Card>
  )
}

/* ── Attendance ──────────────────────────────────────────────────────── */

type AttendanceRow = {
  attendance_date: string
  child_name: string
  service_type: string
  school: string
  on_bus: boolean | number
  submitted_by: string
  submitted_at: string
}

type WeekData = {
  dates: string[]
  daily: Record<string, { attendance: number; absences: number }>
  by_school: Record<string, Record<string, number>>
}

type MonthData = {
  year: number
  month: number
  days: { date: string; attendance: number; absences: number }[]
}

const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']

/** Weekly totals, plus the per-school split the day view can't show. */
function WeekView({ date }: { date: string }) {
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'attendance', 'week', date],
    queryFn: () => api<WeekData>(`/api/admin/attendance/week?date=${date}`),
  })

  if (isPending) return <Skeleton className="h-64 w-full rounded-card" />
  if (!data) return null

  const schools = Object.keys(data.by_school).sort()

  return (
    <Card className="overflow-x-auto p-5">
      {/* The server returns Monday–Friday, so a weekend date shows the week
          that just finished rather than an empty one. */}
      <table className="w-full min-w-[34rem] border-collapse text-left">
        <thead>
          <tr className="border-b-2 border-canvas-200">
            <th className="pb-2 text-[0.8rem] font-bold text-ink-500">&nbsp;</th>
            {data.dates.map((d, i) => (
              <th key={d} className="pb-2 text-center text-[0.8rem] font-bold text-ink-500">
                {DAY_NAMES[i]}
                <span className="block font-medium text-ink-400">{d.slice(5)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-b border-canvas-200">
            <td className="py-3 text-[0.9rem] font-bold text-ink-800">Present</td>
            {data.dates.map((d) => (
              <td key={d} className="py-3 text-center text-[1.15rem] font-extrabold text-ink-900">
                {data.daily[d]?.attendance ?? 0}
              </td>
            ))}
          </tr>
          <tr className="border-b border-canvas-200">
            <td className="py-3 text-[0.9rem] font-bold text-ink-800">Absent</td>
            {data.dates.map((d) => (
              <td key={d} className="py-3 text-center text-[1.15rem] font-extrabold text-berry-600">
                {data.daily[d]?.absences ?? 0}
              </td>
            ))}
          </tr>
          {schools.map((s) => (
            <tr key={s} className="border-b border-canvas-200 last:border-0">
              <td className="py-2.5 text-[0.85rem] font-medium text-ink-600">{s}</td>
              {data.dates.map((d) => (
                <td key={d} className="py-2.5 text-center text-[0.9rem] font-semibold text-ink-600">
                  {data.by_school[s]?.[d] ?? '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {schools.length === 0 && (
        <p className="pt-4 text-center text-[0.85rem] text-ink-500">
          No school-level attendance recorded this week.
        </p>
      )}
    </Card>
  )
}

/** A month at a glance — which days ran, and how full they were. */
function MonthView({ date }: { date: string }) {
  const [year, month] = date.split('-').map(Number)
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'attendance', 'month', year, month],
    queryFn: () =>
      api<MonthData>(`/api/admin/attendance/month?year=${year}&month=${month}`),
  })

  if (isPending) return <Skeleton className="h-64 w-full rounded-card" />
  if (!data) return null

  // Scale each day against the fullest one, so the shading reads as "how busy
  // was this day for us" rather than against an arbitrary fixed ceiling.
  const peak = Math.max(1, ...data.days.map((d) => d.attendance))

  return (
    <Card className="p-5">
      <div className="grid grid-cols-7 gap-1.5">
        {data.days.map((d) => {
          const share = d.attendance / peak
          return (
            <div
              key={d.date}
              title={`${d.date} — ${d.attendance} present, ${d.absences} absent`}
              className="rounded-xl p-2 text-center"
              style={{
                backgroundColor:
                  d.attendance === 0
                    ? 'var(--color-canvas-100)'
                    : `color-mix(in srgb, var(--color-sky-500) ${Math.round(share * 70 + 12)}%, white)`,
              }}
            >
              <p className="text-[0.7rem] font-semibold text-ink-500">
                {Number(d.date.slice(8))}
              </p>
              <p className="text-[0.95rem] font-extrabold text-ink-900">
                {d.attendance || '—'}
              </p>
            </div>
          )
        })}
      </div>
      <p className="mt-4 text-center text-[0.8rem] text-ink-500">
        Children present each day. Hover for the absence count.
      </p>
    </Card>
  )
}

export function AdminAttendance() {
  const [date, setDate] = useState(() => toIso(new Date()))
  const [view, setView] = useState<'day' | 'week' | 'month'>('day')
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'attendance', date],
    queryFn: () => api<AttendanceRow[]>(`/api/admin/attendance?date=${date}`),
    enabled: view === 'day',
  })

  // The API has no id on these rows, so index them for React keys.
  const rows = (data ?? []).map((r, i) => ({ ...r, id: i }))

  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'child_name', header: 'Child' },
    { key: 'school', header: 'School' },
    { key: 'service_type', header: 'Service', secondary: true },
    {
      key: 'on_bus',
      header: 'Present',
      align: 'right',
      value: (r) => (r.on_bus ? 'Present' : 'Absent'),
      render: (r) =>
        r.on_bus ? (
          <Pill status="leaf">Present</Pill>
        ) : (
          <Pill status="berry">Absent</Pill>
        ),
    },
    { key: 'submitted_by', header: 'Marked by', secondary: true },
  ]

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Attendance
      </h1>
      <DayPicker date={date} onChange={setDate}>
        <div className="flex gap-1 rounded-full bg-canvas-100 p-1">
          {(['day', 'week', 'month'] as const).map((v) => (
            <button
              key={v}
              onClick={() => setView(v)}
              className={`rounded-full px-3.5 py-1.5 text-[0.85rem] font-bold capitalize transition-colors ${
                view === v ? 'bg-white text-ink-900 shadow-soft' : 'text-ink-500'
              }`}
            >
              {v}
            </button>
          ))}
        </div>
      </DayPicker>

      {view === 'week' && <WeekView date={date} />}
      {view === 'month' && <MonthView date={date} />}
      {view === 'day' && (
        <DataTable
          rows={rows}
          columns={columns}
          loading={isPending}
          searchPlaceholder="Search children or schools…"
          emptyIcon={<GraduationCap className="size-7" strokeWidth={1.8} />}
          emptyTitle="No attendance recorded"
          emptyBody="Nothing has been marked for this date yet."
          actions={
            <ExportButton
              path={`/api/admin/export/attendance?date=${date}`}
              filename={`attendance-${date}.xlsx`}
            />
          }
        />
      )}
    </div>
  )
}

/* ── Absences ────────────────────────────────────────────────────────── */

type AbsenceRow = {
  child_id: number
  child_name: string
  parent_name: string
  school: string
  absence_date: string
}

type ChildOption = { id: number; name: string; school: string }

/** Undoes one absence — "the child WILL attend this date" (same as the
 * parent's own Remove), not a delete of a log entry. No confirm dialog: it is
 * exactly as reversible as marking one in the first place. */
function UndoAbsence({ childId, date }: { childId: number; date: string }) {
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: () =>
      api('/api/admin/absences', {
        method: 'DELETE',
        body: { child_id: childId, date },
      }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'absences', date] }),
    onError: (e) =>
      notifyError(
        'Could not undo',
        e instanceof ApiError ? e.message : undefined,
      ),
  })
  return (
    <Button
      size="sm"
      variant="outline"
      loading={remove.isPending}
      onClick={() => remove.mutate()}
    >
      Undo
    </Button>
  )
}

/**
 * Recording an absence a parent called in rather than reported through the
 * app. No signature or confirmation step, unlike releasing a child: nobody
 * has to be handed anything back, and Undo above closes the only real risk —
 * marking the wrong kid — in one tap.
 */
function MarkAbsent({ date }: { date: string }) {
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ChildOption | null>(null)

  // The full active roster, fetched once and searched in memory — the same
  // shape AdminConversations already reuses /api/admin/parents for.
  const { data } = useQuery({
    queryKey: ['admin', 'children', 'active-lite'],
    queryFn: () =>
      api<{ children: ChildOption[] }>('/api/admin/children?active=1'),
    staleTime: 60_000,
  })

  const q = query.trim()
  const matches = useMemo(
    () =>
      q
        ? (data?.children ?? []).filter((c) => matchesName(c.name, q)).slice(0, 8)
        : [],
    [data, q],
  )

  const mark = useMutation({
    mutationFn: (childId: number) =>
      api('/api/admin/absences', {
        method: 'POST',
        body: { child_id: childId, date },
      }),
    onSuccess: () => {
      setPicked(null)
      setQuery('')
      void qc.invalidateQueries({ queryKey: ['admin', 'absences', date] })
    },
    onError: (e) =>
      notifyError(
        'Could not mark absent',
        e instanceof ApiError ? e.message : undefined,
      ),
  })

  return (
    <Card className="mb-4 p-3">
      <p className="mb-2 text-[0.85rem] font-bold text-ink-700">
        Mark someone absent
      </p>
      {picked ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.88rem] font-semibold text-ink-800">
            {picked.name}
            <span className="font-medium text-ink-400"> · {picked.school}</span>
            {' — absent on '}
            {date}
          </span>
          <Button
            size="sm"
            loading={mark.isPending}
            onClick={() => mark.mutate(picked.id)}
          >
            Confirm
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPicked(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="relative">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a child by name…"
            aria-label="Search a child to mark absent"
            className="h-10 w-full max-w-sm appearance-none rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-medium text-ink-900 outline-none [&::-webkit-search-cancel-button]:appearance-none focus:border-sky-500"
          />
          {matches.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full max-w-sm overflow-hidden rounded-2xl border border-canvas-200 bg-white shadow-soft">
              {matches.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPicked(c)
                      setQuery('')
                    }}
                    className="flex w-full items-center justify-between px-4 py-2 text-left text-[0.88rem] font-medium transition-colors hover:bg-canvas-100"
                  >
                    <span className="font-bold text-ink-900">{c.name}</span>
                    <span className="text-ink-400">{c.school}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

/**
 * Marking a child present from the office rather than the school gate — a
 * parent calls to say their kid showed up after all, or a Live Board flag
 * gets sorted out over the phone. Calcado de MarkAbsent above it: same
 * search-and-confirm shape, same roster source, different endpoint.
 *
 * Writes `status: 'picked_up'`, the state the app calls "in the building"
 * everywhere else (STATUS_LABEL in lib/attendance.ts) — the same status a
 * counselor's own tap sets, through /api/admin/child-status rather than
 * /api/counselor/child-status, which is closed to admins.
 */
function MarkPresent({ date }: { date: string }) {
  const qc = useQueryClient()
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<ChildOption | null>(null)

  const { data } = useQuery({
    queryKey: ['admin', 'children', 'active-lite'],
    queryFn: () =>
      api<{ children: ChildOption[] }>('/api/admin/children?active=1'),
    staleTime: 60_000,
  })

  const q = query.trim()
  const matches = useMemo(
    () =>
      q
        ? (data?.children ?? []).filter((c) => matchesName(c.name, q)).slice(0, 8)
        : [],
    [data, q],
  )

  const mark = useMutation({
    mutationFn: (childId: number) =>
      api('/api/admin/child-status', {
        method: 'POST',
        body: { child_id: childId, date, status: 'picked_up' },
      }),
    onSuccess: () => {
      setPicked(null)
      setQuery('')
      void qc.invalidateQueries({ queryKey: ['admin', 'absences', date] })
      void qc.invalidateQueries({ queryKey: ['admin', 'attendance', date] })
      void qc.invalidateQueries({ queryKey: ['admin', 'operations'] })
    },
    onError: (e) =>
      notifyError(
        'Could not mark present',
        e instanceof ApiError ? e.message : undefined,
      ),
  })

  return (
    <Card className="mb-4 p-3">
      <p className="mb-2 text-[0.85rem] font-bold text-ink-700">
        Mark someone present
      </p>
      {picked ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[0.88rem] font-semibold text-ink-800">
            {picked.name}
            <span className="font-medium text-ink-400"> · {picked.school}</span>
            {' — present on '}
            {date}
          </span>
          <Button
            size="sm"
            loading={mark.isPending}
            onClick={() => mark.mutate(picked.id)}
          >
            Confirm
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPicked(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <div className="relative">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a child by name…"
            aria-label="Search a child to mark present"
            className="h-10 w-full max-w-sm appearance-none rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-medium text-ink-900 outline-none [&::-webkit-search-cancel-button]:appearance-none focus:border-sky-500"
          />
          {matches.length > 0 && (
            <ul className="absolute z-10 mt-1 w-full max-w-sm overflow-hidden rounded-2xl border border-canvas-200 bg-white shadow-soft">
              {matches.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setPicked(c)
                      setQuery('')
                    }}
                    className="flex w-full items-center justify-between px-4 py-2 text-left text-[0.88rem] font-medium transition-colors hover:bg-canvas-100"
                  >
                    <span className="font-bold text-ink-900">{c.name}</span>
                    <span className="text-ink-400">{c.school}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  )
}

export function AdminAbsences() {
  const [date, setDate] = useState(() => toIso(new Date()))
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'absences', date],
    queryFn: () => api<AbsenceRow[]>(`/api/admin/absences?date=${date}`),
  })

  const rows = (data ?? []).map((r, i) => ({ ...r, id: i }))

  const columns: Column<(typeof rows)[number]>[] = [
    { key: 'child_name', header: 'Child' },
    { key: 'parent_name', header: 'Parent' },
    { key: 'school', header: 'School' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      value: () => '',
      render: (r) => <UndoAbsence childId={r.child_id} date={date} />,
    },
  ]

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Absences
      </h1>
      <DayPicker date={date} onChange={setDate} />
      <MarkPresent date={date} />
      <MarkAbsent date={date} />
      <DataTable
        rows={rows}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search children, parents or schools…"
        emptyIcon={<CalendarDays className="size-7" strokeWidth={1.8} />}
        emptyTitle="Nobody absent"
        emptyBody="No absences reported for this date."
        actions={
          // The export takes a range; this screen shows one day, so it exports
          // the day on screen rather than silently widening to a month.
          <ExportButton
            path={`/api/admin/export/absences?start=${date}&end=${date}`}
            filename={`absences-${date}.xlsx`}
          />
        }
      />
    </div>
  )
}

/* ── Day off requests ────────────────────────────────────────────────── */

type TimeOff = {
  id: number
  counselor_id: number
  counselor_name: string
  off_date: string
  reason: string | null
  status: 'pending' | 'approved' | 'rejected'
  review_note: string | null
  reviewed_by_name: string | null
}

const TONE = { pending: 'sun', approved: 'leaf', rejected: 'berry' } as const

export function AdminTimeOff() {
  const qc = useQueryClient()
  const [filter, setFilter] = useState<'pending' | 'approved' | 'rejected' | 'all'>(
    'pending',
  )

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'time-off', filter],
    queryFn: () =>
      api<TimeOff[]>(
        `/api/admin/time-off${filter === 'all' ? '' : `?status=${filter}`}`,
      ),
  })

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: number; action: 'approve' | 'reject' }) =>
      api(`/api/admin/time-off/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'time-off'] }),
  })

  const columns: Column<TimeOff>[] = [
    {
      key: 'counselor_name',
      header: 'Counselor',
      render: (t) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={t.counselor_name} id={t.counselor_id} size="sm" />
          <span className="font-bold text-ink-900">{t.counselor_name}</span>
        </span>
      ),
    },
    {
      key: 'off_date',
      header: 'Date',
      render: (t) =>
        new Date(`${t.off_date}T12:00:00`).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
        }),
    },
    {
      key: 'reason',
      header: 'Reason',
      value: (t) => t.reason ?? '',
      render: (t) =>
        t.reason ?? <span className="text-ink-400">Not given</span>,
      secondary: true,
    },
    {
      key: 'status',
      header: 'Status',
      render: (t) => <Pill status={TONE[t.status]}>{t.status}</Pill>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      value: () => '',
      render: (t) =>
        t.status === 'pending' ? (
          <span className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="outline"
              loading={
                decide.isPending &&
                decide.variables?.id === t.id &&
                decide.variables.action === 'reject'
              }
              onClick={() => decide.mutate({ id: t.id, action: 'reject' })}
            >
              Reject
            </Button>
            <Button
              size="sm"
              loading={
                decide.isPending &&
                decide.variables?.id === t.id &&
                decide.variables.action === 'approve'
              }
              onClick={() => decide.mutate({ id: t.id, action: 'approve' })}
            >
              Approve
            </Button>
          </span>
        ) : null,
    },
  ]

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Day off requests
      </h1>
      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search counselors…"
        emptyIcon={<UserRound className="size-7" strokeWidth={1.8} />}
        emptyTitle={`No ${filter === 'all' ? '' : filter} requests`}
        actions={
          <div
            role="tablist"
            aria-label="Status"
            className="flex rounded-full bg-canvas-100 p-1"
          >
            {(['pending', 'approved', 'rejected', 'all'] as const).map((s) => (
              <button
                key={s}
                role="tab"
                aria-selected={filter === s}
                onClick={() => setFilter(s)}
                className={`rounded-full px-3 py-1.5 text-[0.8rem] font-bold capitalize transition ${
                  filter === s ? 'bg-white text-ink-900 shadow-soft' : 'text-ink-500'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        }
      />
    </div>
  )
}

/* ── Schools ─────────────────────────────────────────────────────────── */

type SchoolRow = { id: number; name: string; division_type: string }

const DIVISIONS = [
  { value: 'none', label: 'None' },
  { value: 'grade', label: 'Grade' },
  { value: 'torah', label: 'Torah' },
] as const

/**
 * Adds a school with just a name — division_type defaults to 'none' on the
 * server, same as the roster importer creating one on the fly. Set it from
 * Edit once the school exists; a JCC usually knows the name before it knows
 * how the roster splits.
 */
function AddSchoolForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  const create = useMutation({
    mutationFn: () => api('/api/admin/schools', { method: 'POST', body: { name } }),
    onSuccess: () => {
      setName('')
      setError('')
      void qc.invalidateQueries({ queryKey: ['admin', 'schools'] })
      onDone()
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not add that.'),
  })

  return (
    <Card className="mb-4 p-4">
      <p className="mb-3 font-extrabold text-ink-800">Add a school</p>
      <Field
        label="School name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-3"
      />
      {error && (
        <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={!name.trim()} loading={create.isPending} onClick={() => create.mutate()}>
          Add school
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

function EditSchoolForm({
  school,
  onClose,
}: {
  school: SchoolRow
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(school.name)
  const [division, setDivision] = useState(school.division_type)
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api(`/api/admin/schools/${school.id}`, {
        method: 'PUT',
        body: { name: name.trim(), division_type: division },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'schools'] })
      onClose()
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save that.'),
  })

  return (
    <Card className="mb-4 p-4">
      <p className="mb-3 font-extrabold text-ink-800">Edit school</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="School name" value={name} onChange={(e) => setName(e.target.value)} />
        <label className="flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
          Division
          <select
            value={division}
            onChange={(e) => setDivision(e.target.value)}
            className="h-10 rounded-2xl border-2 border-canvas-200 bg-white px-3 text-[0.95rem] font-semibold text-ink-900 outline-none focus:border-sky-500"
          >
            {DIVISIONS.map((d) => (
              <option key={d.value} value={d.value}>
                {d.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <Button disabled={!name.trim()} loading={save.isPending} onClick={() => save.mutate()}>
          Save
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

export function AdminSchools() {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<SchoolRow | null>(null)
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'schools'],
    queryFn: () => api<SchoolRow[]>('/api/admin/schools'),
  })

  const columns: Column<SchoolRow>[] = [
    { key: 'name', header: 'School' },
    {
      key: 'division_type',
      header: 'Division',
      render: (s) =>
        s.division_type === 'none' ? (
          <Pill status="neutral">None</Pill>
        ) : (
          <Pill status="neutral">{s.division_type}</Pill>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      value: () => '',
      render: (s) => (
        <span className="flex items-center justify-end gap-2">
          <EditPersonButton onClick={() => setEditing(s)} />
          <DeletePerson
            endpoint={`/api/admin/schools/${s.id}`}
            what={s.name}
            invalidate={['admin', 'schools']}
          />
        </span>
      ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Schools
      </h1>

      {adding && <AddSchoolForm onDone={() => setAdding(false)} />}
      {editing && (
        <EditSchoolForm school={editing} onClose={() => setEditing(null)} />
      )}

      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search schools…"
        emptyIcon={<School className="size-7" strokeWidth={1.8} />}
        emptyTitle="No schools yet"
        actions={
          <AddButton open={adding} onToggle={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add school'}
          </AddButton>
        }
      />
    </div>
  )
}

/* ── Grades ──────────────────────────────────────────────────────────── */

type GradeRow = { id: number; name: string; sort_order: number }

/** Shared by add and edit — the whole form is one field. */
function GradeNameForm({
  title,
  initial,
  onSave,
  onCancel,
  saving,
  error,
}: {
  title: string
  initial: string
  onSave: (name: string) => void
  onCancel: () => void
  saving: boolean
  error: string
}) {
  const [name, setName] = useState(initial)
  return (
    <Card className="mb-4 p-4">
      <p className="mb-3 font-extrabold text-ink-800">{title}</p>
      <Field
        label="Grade name"
        placeholder="K, 1, 2…"
        hint="The roster's own spelling — 'K' and '0' both mean kindergarten."
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-3"
      />
      {error && (
        <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}
      <div className="flex gap-2">
        <Button disabled={!name.trim()} loading={saving} onClick={() => onSave(name)}>
          Save
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

export function AdminGrades() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<GradeRow | null>(null)
  const [error, setError] = useState('')
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'grades'],
    queryFn: () => api<GradeRow[]>('/api/admin/grades'),
  })

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['admin', 'grades'] })

  const create = useMutation({
    mutationFn: (name: string) =>
      api('/api/admin/grades', { method: 'POST', body: { name } }),
    onSuccess: () => {
      setAdding(false)
      setError('')
      invalidate()
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not add that.'),
  })

  const update = useMutation({
    mutationFn: (name: string) =>
      api(`/api/admin/grades/${editing!.id}`, { method: 'PUT', body: { name } }),
    onSuccess: () => {
      setEditing(null)
      setError('')
      invalidate()
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save that.'),
  })

  const columns: Column<GradeRow>[] = [
    { key: 'name', header: 'Grade' },
    {
      key: 'actions',
      header: '',
      align: 'right',
      value: () => '',
      render: (g) => (
        <span className="flex items-center justify-end gap-2">
          <EditPersonButton
            onClick={() => {
              setError('')
              setEditing(g)
            }}
          />
          <DeletePerson
            endpoint={`/api/admin/grades/${g.id}`}
            what={g.name}
            invalidate={['admin', 'grades']}
          />
        </span>
      ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Grades
      </h1>
      <p className="mb-6 max-w-2xl text-[0.95rem] font-medium text-ink-500">
        The list a child's grade is picked from when adding or editing one.
        Removing a grade here doesn't change any child who already has it —
        it only stops offering that option going forward.
      </p>

      {adding && (
        <GradeNameForm
          title="Add a grade"
          initial=""
          saving={create.isPending}
          error={error}
          onSave={(name) => create.mutate(name)}
          onCancel={() => {
            setAdding(false)
            setError('')
          }}
        />
      )}
      {editing && (
        <GradeNameForm
          title="Edit grade"
          initial={editing.name}
          saving={update.isPending}
          error={error}
          onSave={(name) => update.mutate(name)}
          onCancel={() => {
            setEditing(null)
            setError('')
          }}
        />
      )}

      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search grades…"
        emptyIcon={<GraduationCap className="size-7" strokeWidth={1.8} />}
        emptyTitle="No grades yet"
        emptyBody="Add K, 1st, 2nd… so the child form offers a picker instead of free text."
        actions={
          <AddButton
            open={adding}
            onToggle={() => {
              setAdding((v) => !v)
              setError('')
            }}
          >
            {adding ? 'Cancel' : 'Add grade'}
          </AddButton>
        }
      />
    </div>
  )
}
