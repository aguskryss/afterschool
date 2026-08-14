import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Target, Trash2, Upload } from 'lucide-react'
import { ApiError, api } from '@/lib/api'
import { DataTable, type Column } from '@/components/DataTable'
import { Button, Card, Field, Pill } from '@/components/ui'

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']

type Activity = {
  id: number
  name: string
  category: string | null
  sub_type?: string | null
  season?: string | null
  total?: number
  unassigned?: number
}

type RosterEntry = {
  id: number
  child_name: string
  school: string | null
  option_type: string | null
  grade_group: string | null
  action: string
  day_of_week: string | null
  action_time: string | null
  specific_date: string | null
  source: string | null
  assigned_counselor_id: number | null
  assigned_counselor_name: string | null
}

type Counselor = { id: number; name: string }

function useCounselors() {
  return useQuery({
    queryKey: ['admin', 'counselors'],
    queryFn: () => api<Counselor[]>('/api/admin/counselors'),
  })
}

/* ── One activity's roster ───────────────────────────────────────────── */

/**
 * Who is in this activity, and which counselor owns each drop-off or pickup.
 *
 * Assignment is the point of the screen, so it is done in place rather than
 * behind a modal — an admin filling a season works down a list, and a dialog
 * per row would triple the clicks.
 *
 * Selecting rows enables the bulk assign, which exists because the common case
 * is "every Tuesday pickup is Maria", not one child at a time.
 */
function ActivityRoster({
  activity,
  onBack,
}: {
  activity: Activity
  onBack: () => void
}) {
  const qc = useQueryClient()
  const [day, setDay] = useState('')
  const [action, setAction] = useState('')
  const [onlyUnassigned, setOnlyUnassigned] = useState(false)
  const [picked, setPicked] = useState<Set<number>>(new Set())
  const [bulkTo, setBulkTo] = useState('')

  const params = new URLSearchParams()
  if (day) params.set('day', day)
  if (action) params.set('action', action)
  if (onlyUnassigned) params.set('counselor', 'unassigned')
  const qs = params.toString()

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'activity-roster', activity.id, qs],
    queryFn: () =>
      api<RosterEntry[]>(
        `/api/admin/activity-roster/${activity.id}${qs ? `?${qs}` : ''}`,
      ),
  })

  const { data: counselors } = useCounselors()

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['admin', 'activity-roster', activity.id] })
    void qc.invalidateQueries({ queryKey: ['admin', 'activities'] })
  }

  const assignOne = useMutation({
    mutationFn: ({ id, counselorId }: { id: number; counselorId: number | null }) =>
      api(`/api/admin/activity-roster/${id}/assign`, {
        method: 'PUT',
        body: { counselor_id: counselorId },
      }),
    onSuccess: invalidate,
  })

  const assignMany = useMutation({
    mutationFn: () =>
      api('/api/admin/activity-roster/bulk-assign', {
        method: 'POST',
        body: {
          entry_ids: [...picked],
          counselor_id: bulkTo ? Number(bulkTo) : null,
        },
      }),
    onSuccess: () => {
      setPicked(new Set())
      setBulkTo('')
      invalidate()
    },
  })

  const rows = data ?? []
  const allPicked = rows.length > 0 && picked.size === rows.length

  function toggle(id: number) {
    setPicked((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const columns: Column<RosterEntry>[] = [
    {
      key: 'id',
      header: '',
      render: (r) => (
        <input
          type="checkbox"
          checked={picked.has(r.id)}
          onChange={() => toggle(r.id)}
          aria-label={`Select ${r.child_name}`}
          className="size-4 accent-sky-500"
        />
      ),
    },
    { key: 'child_name', header: 'Child' },
    { key: 'school', header: 'School', secondary: true, value: (r) => r.school ?? '' },
    {
      key: 'action',
      header: 'Action',
      render: (r) => (
        <Pill status={r.action === 'Drop Off' ? 'neutral' : 'sun'}>{r.action}</Pill>
      ),
    },
    {
      key: 'day_of_week',
      header: 'When',
      value: (r) => `${r.specific_date ?? r.day_of_week ?? ''} ${r.action_time ?? ''}`,
      render: (r) => (
        <span>
          {r.specific_date ?? r.day_of_week ?? '—'}
          {r.action_time && (
            <span className="ml-1.5 text-ink-500">{r.action_time}</span>
          )}
        </span>
      ),
    },
    {
      key: 'assigned_counselor_id',
      header: 'Counselor',
      value: (r) => r.assigned_counselor_name ?? '',
      render: (r) => (
        <select
          value={r.assigned_counselor_id ?? ''}
          onChange={(e) =>
            assignOne.mutate({
              id: r.id,
              counselorId: e.target.value ? Number(e.target.value) : null,
            })
          }
          className="h-9 rounded-full border-2 border-canvas-200 bg-white px-3 text-[0.85rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
        >
          <option value="">Unassigned</option>
          {(counselors ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-6xl">
      <Button variant="ghost" size="sm" className="mb-3" onClick={onBack}>
        <ArrowLeft className="size-4" strokeWidth={2.2} />
        All activities
      </Button>
      <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        {activity.name}
      </h1>
      {activity.category && (
        <p className="mb-5 text-[0.95rem] font-medium text-ink-500">
          {activity.category}
          {activity.season ? ` · ${activity.season}` : ''}
        </p>
      )}

      <Card className="mb-4 flex flex-wrap items-center gap-3 p-3">
        <select
          value={day}
          onChange={(e) => setDay(e.target.value)}
          className="h-10 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
        >
          <option value="">Every day</option>
          {DAYS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="h-10 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
        >
          <option value="">Drop-off and pickup</option>
          <option value="Drop Off">Drop-off</option>
          <option value="Pick Up">Pickup</option>
        </select>
        <label className="flex items-center gap-2 text-[0.9rem] font-semibold text-ink-700">
          <input
            type="checkbox"
            checked={onlyUnassigned}
            onChange={(e) => setOnlyUnassigned(e.target.checked)}
            className="size-4 accent-sky-500"
          />
          Needs a counselor
        </label>
        <label className="ml-auto flex items-center gap-2 text-[0.9rem] font-semibold text-ink-700">
          <input
            type="checkbox"
            checked={allPicked}
            onChange={(e) =>
              setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
            }
            className="size-4 accent-sky-500"
          />
          Select all
        </label>
      </Card>

      {picked.size > 0 && (
        <Card className="mb-4 flex flex-wrap items-center gap-3 p-3">
          <span className="text-[0.9rem] font-bold text-ink-800">
            {picked.size} selected
          </span>
          <select
            value={bulkTo}
            onChange={(e) => setBulkTo(e.target.value)}
            className="h-10 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
          >
            <option value="">Unassign</option>
            {(counselors ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            loading={assignMany.isPending}
            onClick={() => assignMany.mutate()}
          >
            Apply to {picked.size}
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
            Clear
          </Button>
        </Card>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search children or schools…"
        emptyIcon={<Target className="size-7" strokeWidth={1.8} />}
        emptyTitle="Nothing matches"
        emptyBody="No roster entries for these filters."
      />
    </div>
  )
}

/* ── Upload an activity roster ───────────────────────────────────────── */

type UploadResult = { added?: number; updated?: number; errors?: string[] }

function ActivityUpload({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<UploadResult | null>(null)

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData()
      form.append('file', file as File)
      return api<UploadResult>('/api/admin/activity-roster/upload', {
        method: 'POST',
        body: form,
      })
    },
    onSuccess: (d) => {
      setResult(d)
      setFile(null)
      onDone()
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That file could not be read.'),
  })

  return (
    <Card className="mb-4 p-5">
      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-canvas-200 px-6 py-8 text-center transition-colors hover:bg-canvas-100">
        <Upload className="size-6 text-ink-400" strokeWidth={1.8} />
        <span className="font-bold text-ink-800">
          {file ? file.name : 'Choose an activity roster'}
        </span>
        <span className="text-[0.85rem] text-ink-500">Excel (.xlsx)</span>
        <input
          type="file"
          accept=".xlsx,.xls"
          className="hidden"
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setResult(null)
            setError('')
          }}
        />
      </label>
      {error && (
        <p className="mt-3 text-[0.9rem] font-semibold text-berry-600">{error}</p>
      )}
      {result && (
        <p className="mt-3 text-[0.9rem] font-semibold text-ink-700">
          Imported. {result.added ?? 0} added, {result.updated ?? 0} updated
          {result.errors?.length ? `, ${result.errors.length} warnings` : ''}.
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <Button disabled={!file} loading={upload.isPending} onClick={() => upload.mutate()}>
          Import
        </Button>
      </div>
    </Card>
  )
}

/* ── Activities list ─────────────────────────────────────────────────── */

export function AdminActivities() {
  const [open, setOpen] = useState<Activity | null>(null)
  const [uploading, setUploading] = useState(false)
  const qc = useQueryClient()

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'activities'],
    queryFn: () => api<Activity[]>('/api/admin/activities'),
  })

  if (open) return <ActivityRoster activity={open} onBack={() => setOpen(null)} />

  const columns: Column<Activity>[] = [
    {
      key: 'name',
      header: 'Activity',
      render: (a) => (
        <button
          onClick={() => setOpen(a)}
          className="text-left font-bold text-sky-600 hover:underline"
        >
          {a.name}
        </button>
      ),
    },
    {
      key: 'category',
      header: 'Category',
      value: (a) => a.category ?? '',
      render: (a) => a.category ?? <span className="text-ink-400">—</span>,
    },
    { key: 'total', header: 'Entries', align: 'right', value: (a) => String(a.total ?? 0) },
    {
      key: 'unassigned',
      header: 'Needs a counselor',
      align: 'right',
      value: (a) => String(a.unassigned ?? 0),
      render: (a) =>
        a.unassigned ? (
          <Pill status="berry">{a.unassigned}</Pill>
        ) : (
          <Pill status="leaf">All covered</Pill>
        ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-6xl">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Activities
      </h1>

      {uploading && (
        <ActivityUpload
          onDone={() => void qc.invalidateQueries({ queryKey: ['admin', 'activities'] })}
        />
      )}

      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search activities…"
        emptyIcon={<Target className="size-7" strokeWidth={1.8} />}
        emptyTitle="No activities yet"
        emptyBody="Activity rosters are created by uploading a spreadsheet."
        actions={
          <Button size="sm" variant="outline" onClick={() => setUploading((v) => !v)}>
            <Upload className="size-4" strokeWidth={2.1} />
            {uploading ? 'Cancel' : 'Upload roster'}
          </Button>
        }
      />
    </div>
  )
}

/* ── Activity schedules ──────────────────────────────────────────────── */

type Schedule = {
  id: number
  activity_name_pattern: string
  day_of_week: string
  dropoff_time: string | null
  pickup_time: string | null
}

/**
 * Default drop-off and pickup times, matched against an activity's name.
 *
 * These are what fill in `action_time` on a roster entry, so an activity with
 * no matching pattern imports with blank times and every counselor guesses.
 */
export function AdminActivitySchedules() {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [pattern, setPattern] = useState('')
  const [dow, setDow] = useState(DAYS[0])
  const [dropoff, setDropoff] = useState('')
  const [pickup, setPickup] = useState('')
  const [error, setError] = useState('')

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'activity-schedules'],
    queryFn: () => api<Schedule[]>('/api/admin/activity-schedules'),
  })

  const done = () => {
    setAdding(false)
    setPattern('')
    setDropoff('')
    setPickup('')
    setError('')
    void qc.invalidateQueries({ queryKey: ['admin', 'activity-schedules'] })
  }

  const add = useMutation({
    mutationFn: () =>
      api('/api/admin/activity-schedules', {
        method: 'POST',
        body: {
          activity_name_pattern: pattern.trim(),
          day_of_week: dow,
          dropoff_time: dropoff || null,
          pickup_time: pickup || null,
        },
      }),
    onSuccess: done,
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'Could not add that schedule.'),
  })

  const update = useMutation({
    mutationFn: (s: Schedule) =>
      api(`/api/admin/activity-schedules/${s.id}`, {
        method: 'PUT',
        body: { dropoff_time: s.dropoff_time || null, pickup_time: s.pickup_time || null },
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'activity-schedules'] }),
  })

  const remove = useMutation({
    mutationFn: (id: number) =>
      api(`/api/admin/activity-schedules/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'activity-schedules'] }),
  })

  const timeCell = (s: Schedule, field: 'dropoff_time' | 'pickup_time') => (
    <input
      type="time"
      defaultValue={s[field] ?? ''}
      onBlur={(e) => {
        if ((s[field] ?? '') === e.target.value) return
        update.mutate({ ...s, [field]: e.target.value })
      }}
      className="h-9 rounded-full border-2 border-canvas-200 bg-white px-3 text-[0.85rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
    />
  )

  const columns: Column<Schedule>[] = [
    { key: 'activity_name_pattern', header: 'Activity name contains' },
    { key: 'day_of_week', header: 'Day' },
    {
      key: 'dropoff_time',
      header: 'Drop-off',
      value: (s) => s.dropoff_time ?? '',
      render: (s) => timeCell(s, 'dropoff_time'),
    },
    {
      key: 'pickup_time',
      header: 'Pickup',
      value: (s) => s.pickup_time ?? '',
      render: (s) => timeCell(s, 'pickup_time'),
    },
    {
      key: 'id',
      header: '',
      align: 'right',
      render: (s) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove the ${s.day_of_week} schedule for ${s.activity_name_pattern}`}
          onClick={() => remove.mutate(s.id)}
        >
          <Trash2 className="size-4" strokeWidth={2.1} />
        </Button>
      ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-5xl">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Activity times
      </h1>

      {adding && (
        <Card className="mb-4 flex flex-col gap-3 p-5">
          <Field
            label="Activity name contains"
            hint="Matched against the activity name on import — e.g. “Swim”."
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
          />
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
              Day
              <select
                value={dow}
                onChange={(e) => setDow(e.target.value)}
                className="h-11 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.92rem] font-medium text-ink-900 outline-none focus:border-sky-500"
              >
                {DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
              Drop-off
              <input
                type="time"
                value={dropoff}
                onChange={(e) => setDropoff(e.target.value)}
                className="h-11 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.92rem] font-medium text-ink-900 outline-none focus:border-sky-500"
              />
            </label>
            <label className="flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
              Pickup
              <input
                type="time"
                value={pickup}
                onChange={(e) => setPickup(e.target.value)}
                className="h-11 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.92rem] font-medium text-ink-900 outline-none focus:border-sky-500"
              />
            </label>
          </div>
          {error && (
            <p className="text-[0.9rem] font-semibold text-berry-600">{error}</p>
          )}
          <div className="flex justify-end">
            <Button
              disabled={!pattern.trim()}
              loading={add.isPending}
              onClick={() => add.mutate()}
            >
              Add schedule
            </Button>
          </div>
        </Card>
      )}

      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search activity names…"
        emptyIcon={<Target className="size-7" strokeWidth={1.8} />}
        emptyTitle="No default times set"
        emptyBody="Without these, an imported activity has no drop-off or pickup time and every counselor guesses."
        actions={
          <Button size="sm" variant="outline" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add times'}
          </Button>
        }
      />
    </div>
  )
}
