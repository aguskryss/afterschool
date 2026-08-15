import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarDays, Mail, Pencil, Plus, Trash2, TriangleAlert, Upload, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { confirmDelete, notifyError } from '@/lib/confirm'
import { DataTable, type Column } from '@/components/DataTable'
import { Button, Card, Field } from '@/components/ui'

/* ── Calendar ────────────────────────────────────────────────────────── */

type Event = {
  id: number
  event_date: string
  event_type: string
  title: string
  description: string | null
}

const EVENT_TYPES = [
  { value: 'closed', label: 'Closed' },
  { value: 'early_dismissal', label: 'Early dismissal' },
  { value: 'mini_camp', label: 'Mini camp' },
  { value: 'special_event', label: 'Special event' },
] as const

/**
 * One event at a time, for the closure that comes up mid-year rather than in
 * the calendar spreadsheet everyone imported in August. Doubles as the edit
 * form — same fields, PUT instead of POST when `event` is given.
 */
function EventForm({
  event,
  onClose,
}: {
  event?: Event
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [eventDate, setEventDate] = useState(event?.event_date ?? '')
  const [eventType, setEventType] = useState(event?.event_type ?? 'special_event')
  const [title, setTitle] = useState(event?.title ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api(event ? `/api/admin/calendar/${event.id}` : '/api/admin/calendar', {
        method: event ? 'PUT' : 'POST',
        body: {
          event_date: eventDate,
          event_type: eventType,
          title: title.trim(),
          description: description.trim(),
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'calendar'] })
      onClose()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not save that.'),
  })

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-extrabold text-ink-800">
          {event ? 'Edit event' : 'Add an event'}
        </p>
        <button
          type="button"
          aria-label="Cancel"
          onClick={onClose}
          className="flex size-8 items-center justify-center rounded-full text-ink-400 hover:bg-canvas-100"
        >
          <X className="size-4" strokeWidth={2.4} />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Date"
          type="date"
          value={eventDate}
          onChange={(e) => setEventDate(e.target.value)}
        />
        <label className="flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
          Type
          <select
            value={eventType}
            onChange={(e) => setEventType(e.target.value)}
            className="h-10 rounded-2xl border-2 border-canvas-200 bg-white px-3 text-[0.95rem] font-semibold text-ink-900 outline-none focus:border-sky-500"
          >
            {EVENT_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <Field
          label="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="sm:col-span-2"
        />
        <Field
          label="Notes"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="sm:col-span-2"
        />
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          disabled={!eventDate || !title.trim()}
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

/** Bulk-add closures and special days from a spreadsheet. */
function CalendarUpload() {
  const qc = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<{ added?: number; errors?: string[] } | null>(
    null,
  )

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData()
      form.append('file', file as File)
      return api<{ added?: number; errors?: string[] }>('/api/admin/calendar/upload', {
        method: 'POST',
        body: form,
      })
    },
    onSuccess: (d) => {
      setResult(d)
      setFile(null)
      setError('')
      void qc.invalidateQueries({ queryKey: ['admin', 'calendar'] })
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That file could not be read.'),
  })

  return (
    <Card className="mb-4 p-5">
      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-canvas-200 px-6 py-8 text-center transition-colors hover:bg-canvas-100">
        <Upload className="size-6 text-ink-400" strokeWidth={1.8} />
        <span className="font-bold text-ink-800">
          {file ? file.name : 'Choose a calendar file'}
        </span>
        <span className="text-[0.85rem] text-ink-500">
          Excel or CSV — a date, a title, and a type such as “closed” or “early
          dismissal”
        </span>
        <input
          type="file"
          accept=".xlsx,.xls,.csv"
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
          {result.added ?? 0} event{result.added === 1 ? '' : 's'} added
          {result.errors?.length ? `, ${result.errors.length} rows skipped` : ''}.
        </p>
      )}
      <div className="mt-4 flex justify-end">
        <Button disabled={!file} loading={upload.isPending} onClick={() => upload.mutate()}>
          Import events
        </Button>
      </div>
    </Card>
  )
}

export function AdminCalendar() {
  const qc = useQueryClient()
  const [uploading, setUploading] = useState(false)
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Event | null>(null)
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'calendar'],
    queryFn: () => api<Event[]>('/api/admin/calendar'),
  })

  const destroy = useMutation({
    mutationFn: (id: number) =>
      api(`/api/admin/calendar/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['admin', 'calendar'] }),
    onError: (e) =>
      notifyError(
        'Could not delete that event',
        e instanceof ApiError ? e.message : undefined,
      ),
  })

  const columns: Column<Event>[] = [
    {
      key: 'event_date',
      header: 'Date',
      render: (e) =>
        new Date(`${e.event_date}T12:00:00`).toLocaleDateString('en-US', {
          weekday: 'short',
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
    },
    { key: 'title', header: 'Event' },
    {
      key: 'event_type',
      header: 'Type',
      secondary: true,
      value: (e) => EVENT_TYPES.find((t) => t.value === e.event_type)?.label ?? e.event_type,
    },
    {
      key: 'description',
      header: 'Notes',
      secondary: true,
      value: (e) => e.description ?? '',
      render: (e) => e.description ?? <span className="text-ink-400">—</span>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      value: () => '',
      render: (e) => (
        <span className="flex items-center justify-end gap-2">
          <button
            type="button"
            aria-label={`Edit ${e.title}`}
            onClick={() => setEditing(e)}
            className="flex size-9 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-canvas-100 hover:text-ink-600"
          >
            <Pencil className="size-4" strokeWidth={2.1} />
          </button>
          <button
            type="button"
            aria-label={`Delete ${e.title}`}
            disabled={destroy.isPending}
            onClick={async () => {
              if (await confirmDelete(e.title)) destroy.mutate(e.id)
            }}
            className="flex size-9 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-berry-50 hover:text-berry-500 disabled:opacity-40"
          >
            <Trash2 className="size-4" strokeWidth={2.1} />
          </button>
        </span>
      ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Calendar
      </h1>
      {uploading && <CalendarUpload />}
      {adding && <EventForm onClose={() => setAdding(false)} />}
      {editing && (
        <EventForm event={editing} onClose={() => setEditing(null)} />
      )}
      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search events…"
        emptyIcon={<CalendarDays className="size-7" strokeWidth={1.8} />}
        emptyTitle="No events scheduled"
        emptyBody="Closures and special days added here show up in every parent's calendar."
        actions={
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => setAdding((v) => !v)}>
              <Plus className="size-4" strokeWidth={2.6} />
              {adding ? 'Cancel' : 'Add event'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setUploading((v) => !v)}>
              <Upload className="size-4" strokeWidth={2.1} />
              {uploading ? 'Cancel' : 'Import events'}
            </Button>
          </div>
        }
      />
    </div>
  )
}

/* ── Messages ────────────────────────────────────────────────────────── */

type Message = {
  id: number
  subject: string
  body: string
  created_at: string
  recipient_count?: number
  sender_name?: string | null
}

type School = { id: number; name: string }

/**
 * Compose a broadcast.
 *
 * The recipient count is fetched from the server rather than counted here,
 * because "parents at these schools" means whatever `_resolve_message_recipients`
 * says it means — children have to be active, parents have to exist. A number
 * computed in the browser would drift from the one that actually gets written,
 * and this is a screen where the number is the last thing an admin checks
 * before sending to a few hundred families.
 */
function ComposeMessage({ onSent }: { onSent: () => void }) {
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [toAll, setToAll] = useState(true)
  const [schoolIds, setSchoolIds] = useState<number[]>([])
  const [error, setError] = useState('')

  const { data: schools } = useQuery({
    queryKey: ['admin', 'schools'],
    queryFn: () => api<School[]>('/api/admin/schools'),
  })

  const audience = toAll
    ? { audience_type: 'all' as const, school_ids: [] as number[] }
    : { audience_type: 'schools' as const, school_ids: schoolIds }

  const { data: preview } = useQuery({
    queryKey: ['admin', 'messages', 'preview', audience.audience_type, schoolIds],
    queryFn: () =>
      // `recipient_count`, not `count`: the server has always named it that,
      // and reading the wrong key rendered "undefined parents" beside the Send
      // button — the one number an admin uses to sanity-check a broadcast
      // before it goes to every family in the program.
      api<{
        recipient_count: number
        parents_without_children: number
      }>('/api/admin/messages/preview-count', {
        method: 'POST',
        body: audience,
      }),
    enabled: toAll || schoolIds.length > 0,
  })

  const send = useMutation({
    mutationFn: () =>
      api('/api/admin/messages', {
        method: 'POST',
        body: { subject: subject.trim(), body: body.trim(), ...audience },
      }),
    onSuccess: () => {
      setSubject('')
      setBody('')
      setError('')
      onSent()
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That message did not send.'),
  })

  const ready =
    subject.trim().length > 0 &&
    body.trim().length > 0 &&
    (toAll || schoolIds.length > 0)

  return (
    <Card className="mb-4 flex flex-col gap-3 p-5">
      <Field
        label="Subject"
        maxLength={200}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
      />
      <label className="flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
        Message
        <textarea
          rows={5}
          maxLength={4000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          className="rounded-2xl border-2 border-canvas-200 bg-white px-4 py-3 text-[0.95rem] font-medium text-ink-900 outline-none focus:border-sky-500"
        />
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[0.9rem] font-semibold text-ink-700">
          <input
            type="radio"
            checked={toAll}
            onChange={() => setToAll(true)}
            className="size-4 accent-sky-500"
          />
          Every parent
        </label>
        <label className="flex items-center gap-2 text-[0.9rem] font-semibold text-ink-700">
          <input
            type="radio"
            checked={!toAll}
            onChange={() => setToAll(false)}
            className="size-4 accent-sky-500"
          />
          Pick schools
        </label>
      </div>

      {!toAll && (
        <div className="flex flex-wrap gap-2">
          {(schools ?? []).map((s) => {
            const on = schoolIds.includes(s.id)
            return (
              <button
                key={s.id}
                onClick={() =>
                  setSchoolIds((prev) =>
                    on ? prev.filter((id) => id !== s.id) : [...prev, s.id],
                  )
                }
                className={`rounded-full px-3.5 py-1.5 text-[0.85rem] font-bold transition-colors ${
                  on
                    ? 'bg-sky-500 text-white'
                    : 'border-2 border-canvas-200 text-ink-600 hover:bg-canvas-100'
                }`}
              >
                {s.name}
              </button>
            )
          })}
        </div>
      )}

      {error && <p className="text-[0.9rem] font-semibold text-berry-600">{error}</p>}

      {/* Every audience — including "everyone" — is resolved through children,
          so a parent with none is unreachable by any broadcast. Said here
          because the alternative is an admin concluding that broadcasts are
          broken, which is exactly what happened. */}
      {preview && preview.parents_without_children > 0 && (
        <p className="rounded-xl bg-sun-50 p-3 text-[0.85rem] font-semibold text-sun-700">
          {preview.parents_without_children} parent
          {preview.parents_without_children === 1 ? '' : 's'} will not receive
          this: they have no child on the roster, and an announcement reaches
          families through their children. Give them one from the Parents
          screen.
        </p>
      )}

      <div className="flex items-center justify-end gap-3">
        {preview && (
          <span className="text-[0.88rem] font-bold text-ink-500">
            {preview.recipient_count} parent
            {preview.recipient_count === 1 ? '' : 's'}
          </span>
        )}
        <Button disabled={!ready} loading={send.isPending} onClick={() => send.mutate()}>
          Send
        </Button>
      </div>
    </Card>
  )
}

export function AdminMessages() {
  const qc = useQueryClient()
  const [composing, setComposing] = useState(false)
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'messages'],
    queryFn: () => api<Message[]>('/api/admin/messages'),
  })

  const columns: Column<Message>[] = [
    { key: 'subject', header: 'Subject' },
    {
      key: 'body',
      header: 'Message',
      secondary: true,
      render: (m) => (
        <span className="line-clamp-1 max-w-md text-ink-500">{m.body}</span>
      ),
    },
    {
      key: 'created_at',
      header: 'Sent',
      align: 'right',
      render: (m) =>
        new Date(m.created_at).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        }),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Messages
      </h1>
      {composing && (
        <ComposeMessage
          onSent={() => {
            setComposing(false)
            void qc.invalidateQueries({ queryKey: ['admin', 'messages'] })
          }}
        />
      )}
      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search messages…"
        emptyIcon={<Mail className="size-7" strokeWidth={1.8} />}
        emptyTitle="No messages sent"
        emptyBody="Announcements you send land in every parent's inbox."
        actions={
          <Button size="sm" variant="outline" onClick={() => setComposing((v) => !v)}>
            {composing ? 'Cancel' : 'New message'}
          </Button>
        }
      />
    </div>
  )
}

/* ── Upload roster ───────────────────────────────────────────────────── */

type UploadResult = {
  added_parents: number
  added_children: number
  skipped_children: number
  deactivated_children: number
  errors: string[]
}

/**
 * Roster upload.
 *
 * The endpoint replaces the roster rather than adding to it: it sets every
 * child inactive and re-activates only the ones the file contains. Uploading
 * one school's list therefore deactivates every other school's children, and
 * the whole thing runs in one transaction, so there is no partial result to
 * inspect afterwards. The legacy portal only reported that count once the
 * damage was done; this says it before the file is sent, which is the one
 * thing worth adding while rebuilding the screen.
 */
export function AdminUpload() {
  const [file, setFile] = useState<File | null>(null)
  const [result, setResult] = useState<UploadResult | null>(null)
  const [error, setError] = useState('')

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData()
      form.append('file', file as File)
      return api<UploadResult>('/api/admin/upload-roster', {
        method: 'POST',
        body: form,
      })
    },
    onSuccess: (data) => {
      setResult(data)
      setFile(null)
      setError('')
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : 'That file could not be imported.',
      ),
  })

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Upload roster
      </h1>

      <Card className="mb-4 p-6">
        <div className="mb-5 flex gap-3 rounded-2xl bg-sun-50 p-4">
          <TriangleAlert
            className="size-5 shrink-0 text-coral-700"
            strokeWidth={2.1}
          />
          <p className="text-[0.9rem] font-medium text-ink-700">
            This <strong>replaces</strong> the roster. Any child not listed in the
            file is deactivated, so upload the full program in one file — not one
            school at a time.
          </p>
        </div>

        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-canvas-200 px-6 py-10 text-center transition-colors hover:bg-canvas-100">
          <Upload className="size-7 text-ink-400" strokeWidth={1.8} />
          <span className="font-bold text-ink-800">
            {file ? file.name : 'Choose a roster file'}
          </span>
          <span className="text-[0.85rem] text-ink-500">
            Excel (.xlsx, .xls) or CSV
          </span>
          <input
            type="file"
            accept=".xlsx,.xls,.csv"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setResult(null)
              setError('')
            }}
          />
        </label>

        {error && (
          <p className="mt-4 text-[0.9rem] font-semibold text-berry-600">{error}</p>
        )}

        <div className="mt-5 flex justify-end">
          <Button
            disabled={!file}
            loading={upload.isPending}
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? 'Importing…' : 'Import roster'}
          </Button>
        </div>
      </Card>

      {result && (
        <Card className="p-6">
          <p className="mb-4 text-lg font-extrabold text-ink-900">Import complete</p>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['New parents', result.added_parents],
                ['New children', result.added_children],
                ['Updated', result.skipped_children],
                ['Deactivated', result.deactivated_children],
              ] as const
            ).map(([label, value]) => (
              <div key={label} className="rounded-2xl bg-canvas-100 p-4">
                <p className="text-[1.6rem] font-extrabold leading-none text-ink-900">
                  {value}
                </p>
                <p className="mt-1 text-[0.8rem] font-semibold text-ink-500">
                  {label}
                </p>
              </div>
            ))}
          </dl>

          {result.errors.length > 0 && (
            <div className="mt-5 rounded-2xl bg-sun-50 p-4">
              <p className="mb-2 text-[0.9rem] font-bold text-ink-800">
                {result.errors.length} row
                {result.errors.length === 1 ? '' : 's'} needed attention
              </p>
              <ul className="space-y-1 text-[0.85rem] text-ink-600">
                {result.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
