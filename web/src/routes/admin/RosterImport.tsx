import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { FileSpreadsheet, Upload, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { DataTable, type Column } from '@/components/DataTable'
import { Button, Card, EmptyState, Pill } from '@/components/ui'

/**
 * Import the JCC's own roster spreadsheet, with a look at what it will do
 * before it does it.
 *
 * The server half is in server/roster_staging.py and deliberately runs in three
 * steps: an upload only *stages* a parse, an administrator reads it, and a
 * second call is what actually writes to `children`. This screen is those three
 * steps. It never parses anything itself — the numbers below and the rows that
 * commit are read back out of the same staged batch, so the screen cannot
 * promise 157 and have the import write 156.
 *
 * Distinct from /upload, which is the roster uploader every other JCC uses:
 * that one replaces the roster wholesale and deactivates any child not in the
 * file. This one is additive and reversible up until the Import button.
 */

/* ── The staging contract ────────────────────────────────────────────── */

type Action = 'create' | 'update' | 'unchanged' | 'withdraw' | 'skip' | 'blocked'

type Notice = {
  code: string
  message: string
  level: 'error' | 'warning' | 'info'
  sheet: string | null
  /** The spreadsheet's own 1-based row number, so it can be typed into Excel. */
  row: number | null
  column: string | null
  value: string | null
}

type Change = { field: string; from: unknown; to: unknown }

type Contact = {
  priority: number
  name: string | null
  phone: string | null
  email: string | null
}

/** A class with its hours split off its name — `Soccer 3:15p-4p` in the file. */
type ParsedClass = {
  name: string
  start_time: string | null
  end_time: string | null
  raw: string | null
}

type Registration = {
  day_of_week: string
  dismissal_time: number | null
  starred: boolean
  classes: ParsedClass[]
}

type Compliance = {
  item: string
  status: string
  recorded_on: string | null
  raw_value: string | null
}

type Parsed = {
  school_norm?: string | null
  arrival_mode?: string | null
  dob?: string | null
  sex?: string | null
  allergies?: string | null
  bus_rider?: boolean | null
  notes?: string | null
  roster_flag?: string | null
  status?: string
  registrations?: Registration[]
  contacts?: Contact[]
  compliance?: Compliance[]
}

type Row = {
  id: number
  source_sheet: string | null
  source_row: number | null
  action: Action
  match_child_id: number | null
  child_name: string | null
  school_raw: string | null
  grade_raw: string | null
  parsed: Parsed
  changes: Change[]
  notices: Notice[]
  applied_at: string | null
}

type Alias = {
  id: number
  alias: string
  alias_norm: string
  school_id: number | null
  school_name: string | null
  source: string
}

type Applied = {
  created: number
  updated: number
  unchanged: number
  withdrawn: number
  skipped: number
  blocked: number
  parent_accounts_created: number
  classes?: number
  class_enrolments?: number
  /** Where the file's hours differ from hours already on the Classes screen.
   *  The screen's version is kept; these say which and why. */
  class_warnings?: string[]
}

type Totals = {
  actions?: Partial<Record<Action, number>>
  applied?: Applied
  rows_read?: number
  children?: number
  rows_merged?: number
  draft_rows?: number
  legend_rows?: number
  children_without_days?: number
  children_without_dob?: number
  children_without_contacts?: number
  warnings?: number
  classes?: number
  class_enrolments?: number
}

type Preview = {
  id: number
  filename: string
  status: 'preview' | 'committed' | 'discarded'
  uploaded_at: string
  committed_at: string | null
  error: string | null
  totals: Totals
  schools: Alias[]
  rows: Row[]
}

type Batch = {
  id: number
  filename: string
  status: string
  uploaded_at: string
  committed_at: string | null
  totals: Totals
  uploaded_by_name: string | null
}

type School = { id: number; name: string }

/* ── Vocabulary ──────────────────────────────────────────────────────── */

const ACTIONS: Action[] = [
  'create',
  'update',
  'unchanged',
  'withdraw',
  'skip',
  'blocked',
]

const ACTION_LABEL: Record<Action, string> = {
  create: 'New',
  update: 'Updated',
  unchanged: 'No change',
  withdraw: 'Withdrawn',
  skip: 'Skipped',
  blocked: 'Blocked',
}

const ACTION_PILL: Record<Action, 'leaf' | 'sun' | 'berry' | 'coral' | 'neutral'> =
  {
    create: 'leaf',
    update: 'sun',
    unchanged: 'neutral',
    withdraw: 'coral',
    skip: 'neutral',
    blocked: 'berry',
  }

/** `bus_rider` → `Bus rider`. Derived rather than mapped, so a field added to
 *  the staging diff shows up here without anyone remembering this file. */
function label(field: string): string {
  const words = field.replace(/_/g, ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

function show(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

/** `15:15` → `3:15pm`. Built by hand: these are wall-clock strings with no date
 *  and no zone, and putting them through Date() would give them today's. */
function clock(value: string | null): string | null {
  const match = /^(\d{1,2}):(\d{2})/.exec(value ?? '')
  if (!match) return null
  const hour = Number(match[1])
  const suffix = hour < 12 ? 'am' : 'pm'
  const twelve = hour % 12 === 0 ? 12 : hour % 12
  return `${twelve}:${match[2]}${suffix}`
}

/** `Soccer · 3:15pm–4:00pm`, or just the name where the file gave no hours. */
function classLabel(entry: ParsedClass): string {
  const start = clock(entry.start_time)
  const end = clock(entry.end_time)
  if (!start) return entry.name
  return `${entry.name} ${start}–${end ?? '?'}`
}

/* ── Summary ─────────────────────────────────────────────────────────── */

function SummaryTiles({ totals }: { totals: Totals }) {
  const actions = totals.actions ?? {}

  // The counts nobody sees anywhere else. `children_without_days` in
  // particular has to be on this screen: those are the children the billing
  // column flags, they import correctly, and no daily view will show them —
  // without the number here the next phase looks broken. See the note at
  // server/roster_import.py, `totals`.
  // Zeros are dropped. Five of them in a row is the kind of line people learn
  // to skip, and then the one time it says 60 they skip that too.
  const asides: [number | undefined, string, string][] = [
    [totals.children_without_days, 'child has no day enrolled', 'children have no day enrolled'],
    [totals.children_without_dob, 'child has no date of birth', 'children have no date of birth'],
    [totals.children_without_contacts, 'child has no contacts', 'children have no contacts'],
    [totals.rows_merged, 'row was merged into another', 'rows were merged into others'],
    [totals.draft_rows, 'incomplete row was ignored', 'incomplete rows were ignored'],
  ]

  return (
    <>
      <dl className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {ACTIONS.map((action) => (
          <div key={action} className="rounded-2xl bg-white p-4 shadow-soft">
            <dd className="text-[1.6rem] leading-none font-extrabold text-ink-900">
              {actions[action] ?? 0}
            </dd>
            <dt className="mt-1 text-[0.8rem] font-semibold text-ink-500">
              {ACTION_LABEL[action]}
            </dt>
          </div>
        ))}
      </dl>

      {/* The activities, said out loud. The counts above are all about
          children, and for a file whose point is "who is in what class on what
          day" that leaves the reader with no way to tell whether the classes
          were read at all — which is exactly how a roster that imported no
          activities once looked identical to one that imported them all. */}
      {!!totals.classes && (
        <p className="mb-4 rounded-2xl bg-canvas-100 px-4 py-3 text-[0.88rem] font-medium text-ink-700">
          <strong className="font-extrabold text-ink-900">
            {plural(totals.classes, 'activity', 'activities')}
          </strong>{' '}
          read from the day columns, with{' '}
          <strong className="font-extrabold text-ink-900">
            {plural(totals.class_enrolments ?? 0, 'child signed up', 'sign-ups')}
          </strong>
          . Open any row to see a child&rsquo;s week. Hours written into a class
          name are read with it, so they arrive on the Classes screen ready to
          give a room and a counselor.
        </p>
      )}

      <p className="mb-5 flex flex-wrap gap-x-4 gap-y-1 text-[0.82rem] font-medium text-ink-500">
        {asides
          .filter(([count]) => !!count)
          .map(([count, one, many]) => (
            <span key={one}>
              <strong className="font-extrabold text-ink-700">{count}</strong>{' '}
              {count === 1 ? one : many}
            </span>
          ))}
      </p>
    </>
  )
}

/* ── Schools the file names that we cannot place ─────────────────────── */

/**
 * A school the importer could not map to one of ours.
 *
 * Only cells with no name in them reach this list. A cell that names a school
 * this JCC does not have yet is created outright at upload — otherwise a JCC's
 * very first import would block on all five of its schools, which is exactly
 * the retyping the feature exists to remove. What lands here is `????` and
 * friends: there is no name to create a school from, so a person has to say.
 */
function UnresolvedSchools({
  aliases,
  schools,
  onResolved,
}: {
  aliases: Alias[]
  schools: School[]
  onResolved: () => void
}) {
  const [error, setError] = useState('')

  const resolve = useMutation({
    mutationFn: (vars: { id: number; school_id?: number; school_name?: string }) =>
      api<Alias>(`/api/admin/school-aliases/${vars.id}`, {
        method: 'PUT',
        body: vars.school_id
          ? { school_id: vars.school_id }
          : { school_name: vars.school_name },
      }),
    onSuccess: () => {
      setError('')
      onResolved()
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : 'That school could not be saved.',
      ),
  })

  return (
    <Card className="mb-4 p-5">
      <p className="text-[1.05rem] font-extrabold text-ink-900">
        {aliases.length} school{aliases.length === 1 ? '' : 's'} still need
        {aliases.length === 1 ? 's' : ''} an answer
      </p>
      <p className="mt-1 mb-4 text-[0.88rem] font-medium text-ink-600">
        The file does not name these, so the children in them cannot be placed.
        Point each one at a school, or type a new name.
      </p>

      <ul className="flex flex-col gap-3">
        {aliases.map((alias) => (
          <AliasRow
            key={alias.id}
            alias={alias}
            schools={schools}
            pending={resolve.isPending}
            onPick={(vars) => resolve.mutate({ id: alias.id, ...vars })}
          />
        ))}
      </ul>

      {error && (
        <p className="mt-3 text-[0.88rem] font-semibold text-berry-600">{error}</p>
      )}
    </Card>
  )
}

function AliasRow({
  alias,
  schools,
  pending,
  onPick,
}: {
  alias: Alias
  schools: School[]
  pending: boolean
  onPick: (vars: { school_id?: number; school_name?: string }) => void
}) {
  const [name, setName] = useState('')

  return (
    <li className="flex flex-wrap items-center gap-3 rounded-2xl bg-canvas-100 p-3">
      <code className="rounded-lg bg-white px-2.5 py-1 text-[0.85rem] font-bold text-ink-800">
        {alias.alias}
      </code>

      <select
        defaultValue=""
        disabled={pending}
        onChange={(e) => e.target.value && onPick({ school_id: Number(e.target.value) })}
        aria-label={`School for ${alias.alias}`}
        className="h-9 rounded-full border-2 border-canvas-200 bg-white px-3 text-[0.85rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
      >
        <option value="">Choose a school…</option>
        {schools.map((school) => (
          <option key={school.id} value={school.id}>
            {school.name}
          </option>
        ))}
      </select>

      <span className="text-[0.8rem] font-semibold text-ink-400">or</span>

      <input
        value={name}
        disabled={pending}
        onChange={(e) => setName(e.target.value)}
        placeholder="New school name"
        aria-label={`New school name for ${alias.alias}`}
        className="h-9 min-w-40 flex-1 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.85rem] font-medium text-ink-900 outline-none placeholder:font-normal placeholder:text-ink-400 focus:border-sky-500"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!name.trim() || pending}
        onClick={() => onPick({ school_name: name.trim() })}
      >
        Add
      </Button>
    </li>
  )
}

/* ── One row, in full ────────────────────────────────────────────────── */

/**
 * Everything the parser read for one child.
 *
 * Behind a click on purpose. The table has to be scannable, and dates of birth,
 * allergies and parents' phone numbers for a hundred and fifty children sitting
 * in an open grid is more of them on screen than the job needs.
 */
function RowDetail({ row, onClose }: { row: Row; onClose: () => void }) {
  const p = row.parsed
  // A day counts if it has an hour *or* a class. Filtering on the hour alone
  // hid the day of a child whose dismissal cell could not be read but whose
  // class cell was perfectly clear — which is the case worth looking at.
  const days = (p.registrations ?? []).filter(
    (r) => r.dismissal_time !== null || r.classes.length > 0,
  )

  const facts: [string, string][] = [
    ['School', row.school_raw ?? '—'],
    ['Grade', row.grade_raw ?? '—'],
    ['Date of birth', show(p.dob)],
    ['Arrival', show(p.arrival_mode)],
    ['Allergies', show(p.allergies)],
    ['Bus rider', show(p.bus_rider)],
    ['Roster flag', show(p.roster_flag)],
    ['Notes', show(p.notes)],
  ]

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={row.child_name ?? 'Roster row'}
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
        className="max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-card bg-white p-5 shadow-lift"
      >
        <div className="mb-1 flex items-center gap-3">
          <h2 className="text-[1.1rem] font-extrabold text-ink-900">
            {row.child_name || 'Unnamed row'}
          </h2>
          <Pill status={ACTION_PILL[row.action]}>{ACTION_LABEL[row.action]}</Pill>
        </div>
        <p className="mb-4 text-[0.82rem] font-semibold text-ink-500">
          {row.source_sheet} · row {row.source_row}
        </p>

        {row.notices.length > 0 && (
          <ul className="mb-4 flex flex-col gap-2">
            {row.notices.map((notice, i) => (
              <li
                key={i}
                className={`rounded-2xl px-4 py-2.5 text-[0.85rem] font-medium ${
                  notice.level === 'error'
                    ? 'bg-berry-50 text-berry-600'
                    : notice.level === 'warning'
                      ? 'bg-sun-50 text-ink-700'
                      : 'bg-canvas-100 text-ink-600'
                }`}
              >
                {notice.message}
                {notice.column && (
                  <span className="font-semibold"> (column {notice.column})</span>
                )}
              </li>
            ))}
          </ul>
        )}

        {row.changes.length > 0 && (
          <>
            <h3 className="mb-2 text-[0.9rem] font-extrabold text-ink-800">
              What this changes
            </h3>
            <ul className="mb-4 flex flex-col gap-1.5 text-[0.85rem]">
              {row.changes.map((change) => (
                <li key={change.field} className="flex flex-wrap gap-x-2">
                  <span className="font-bold text-ink-700">
                    {label(change.field)}
                  </span>
                  <span className="text-ink-400 line-through">
                    {show(change.from)}
                  </span>
                  <span aria-hidden className="text-ink-400">
                    →
                  </span>
                  <span className="font-semibold text-ink-900">
                    {show(change.to)}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}

        <h3 className="mb-2 text-[0.9rem] font-extrabold text-ink-800">
          From the file
        </h3>
        <dl className="mb-4 grid grid-cols-2 gap-x-4 gap-y-2 text-[0.85rem] sm:grid-cols-3">
          {facts.map(([term, value]) => (
            <div key={term}>
              <dt className="text-[0.75rem] font-semibold text-ink-500">{term}</dt>
              <dd className="font-semibold text-ink-900">{value}</dd>
            </div>
          ))}
        </dl>

        <h3 className="mb-2 text-[0.9rem] font-extrabold text-ink-800">
          Days ({days.length})
        </h3>
        {days.length === 0 ? (
          <p className="mb-4 text-[0.85rem] font-medium text-ink-500">
            No day is enrolled. This child still imports; no daily view will
            show them.
          </p>
        ) : (
          <ul className="mb-4 flex flex-col gap-1 text-[0.85rem]">
            {days.map((day) => (
              <li key={day.day_of_week}>
                <span className="font-bold text-ink-700">{day.day_of_week}</span>{' '}
                <span className="text-ink-600">
                  {day.dismissal_time === null
                    ? 'no pick-up hour read'
                    : `out at ${day.dismissal_time}:00`}
                  {day.starred && ' ★'}
                </span>
                {day.classes.length > 0 && (
                  <span className="text-ink-600">
                    {' · '}
                    {day.classes.map((c) => classLabel(c)).join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}

        <h3 className="mb-2 text-[0.9rem] font-extrabold text-ink-800">Contacts</h3>
        {(p.contacts ?? []).length === 0 ? (
          <p className="mb-4 text-[0.85rem] font-medium text-ink-500">None read.</p>
        ) : (
          <ul className="mb-4 flex flex-col gap-1 text-[0.85rem]">
            {(p.contacts ?? []).map((contact) => (
              <li key={contact.priority}>
                <span className="font-bold text-ink-700">
                  #{contact.priority} {contact.name || '—'}
                </span>
                <span className="text-ink-600">
                  {contact.phone && ` · ${contact.phone}`}
                  {contact.email && ` · ${contact.email}`}
                </span>
              </li>
            ))}
          </ul>
        )}

        {(p.compliance ?? []).length > 0 && (
          <>
            <h3 className="mb-2 text-[0.9rem] font-extrabold text-ink-800">
              Paperwork
            </h3>
            <ul className="flex flex-wrap gap-1.5">
              {(p.compliance ?? []).map((item) => (
                <li key={item.item}>
                  <Pill status={item.status === 'done' ? 'leaf' : 'neutral'}>
                    {label(item.item)}
                    {item.raw_value ? `: ${item.raw_value}` : ''}
                  </Pill>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}

/* ── Past imports ────────────────────────────────────────────────────── */

function History({ batches }: { batches: Batch[] }) {
  if (batches.length === 0) return null
  return (
    <Card className="p-5">
      <h2 className="mb-3 text-[1.05rem] font-extrabold text-ink-900">
        Recent imports
      </h2>
      <ul className="flex flex-col gap-2.5">
        {batches.map((batch) => {
          const applied = batch.totals?.applied
          return (
            <li
              key={batch.id}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-canvas-200 pb-2.5 text-[0.88rem] last:border-0 last:pb-0"
            >
              <span className="font-bold text-ink-800">{batch.filename}</span>
              <span className="text-ink-500">{when(batch.uploaded_at)}</span>
              {batch.uploaded_by_name && (
                <span className="text-ink-400">by {batch.uploaded_by_name}</span>
              )}
              <span className="ml-auto">
                <Pill status={batch.status === 'committed' ? 'leaf' : 'neutral'}>
                  {batch.status}
                </Pill>
              </span>
              {applied && (
                <span className="w-full text-[0.82rem] font-medium text-ink-500">
                  {applied.created} new · {applied.updated} updated ·{' '}
                  {applied.withdrawn} withdrawn · {applied.blocked} skipped
                </span>
              )}
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ── The screen ──────────────────────────────────────────────────────── */

export function AdminRosterImport() {
  const queryClient = useQueryClient()

  // The chosen file is held onto after the upload. Resolving a school does not
  // revisit rows that were already staged as blocked — commit() skips them
  // without re-checking — so the only way to act on an answer is to stage the
  // file again, and asking Heather to go and find it a second time is a poor
  // way to say that.
  const [file, setFile] = useState<File | null>(null)
  const [batchId, setBatchId] = useState<number | null>(null)
  const [result, setResult] = useState<Applied | null>(null)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<Row | null>(null)
  const [filter, setFilter] = useState<Action | 'all'>('all')

  const batches = useQuery({
    queryKey: ['admin', 'roster-import'],
    queryFn: () => api<Batch[]>('/api/admin/roster-import'),
  })

  const schools = useQuery({
    queryKey: ['admin', 'schools'],
    queryFn: () => api<School[]>('/api/admin/schools'),
  })

  const preview = useQuery({
    queryKey: ['admin', 'roster-import', batchId],
    queryFn: () => api<Preview>(`/api/admin/roster-import/${batchId}`),
    enabled: batchId !== null,
  })

  function stage(chosen: File) {
    const form = new FormData()
    form.append('file', chosen)
    return api<Preview>('/api/admin/roster-import', { method: 'POST', body: form })
  }

  function landOn(staged: Preview) {
    queryClient.setQueryData(['admin', 'roster-import', staged.id], staged)
    setBatchId(staged.id)
    setResult(null)
    setError('')
    setFilter('all')
  }

  const upload = useMutation({
    mutationFn: () => stage(file as File),
    onSuccess: landOn,
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : 'That file could not be read.',
      ),
  })

  // Stage first, discard second: if the file has become unreadable in the
  // meantime the preview already on screen survives instead of vanishing.
  const recheck = useMutation({
    mutationFn: async () => {
      const staged = await stage(file as File)
      const stale = batchId
      if (stale && stale !== staged.id) {
        await api(`/api/admin/roster-import/${stale}`, { method: 'DELETE' }).catch(
          () => undefined,
        )
      }
      return staged
    },
    onSuccess: landOn,
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : 'That file could not be read.',
      ),
  })

  const commit = useMutation({
    mutationFn: () =>
      api<{ applied: Applied }>(`/api/admin/roster-import/${batchId}/commit`, {
        method: 'POST',
      }),
    onSuccess: (data) => {
      setResult(data.applied)
      setBatchId(null)
      setFile(null)
      setError('')
      // The import writes children, parents, schools and registrations, so
      // every admin list behind this screen is now stale.
      queryClient.invalidateQueries()
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : 'The import could not be applied.',
      ),
  })

  const discard = useMutation({
    mutationFn: () =>
      api(`/api/admin/roster-import/${batchId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setBatchId(null)
      setFile(null)
      setError('')
      queryClient.invalidateQueries({ queryKey: ['admin', 'roster-import'] })
    },
  })

  const data = preview.data
  const unresolved = (data?.schools ?? []).filter((s) => s.school_id === null)

  // Rows held back by a school that has since been answered. Their staged
  // action is stale, not wrong-forever: staging the same file again re-reads
  // the aliases and lets them through.
  const stale = useMemo(() => {
    if (!data) return 0
    const answered = new Set(
      data.schools.filter((s) => s.school_id !== null).map((s) => s.alias_norm),
    )
    return data.rows.filter(
      (row) =>
        row.action === 'blocked' &&
        row.notices.some((n) => n.code === 'school_unresolved') &&
        answered.has(String(row.parsed.school_norm ?? '')),
    ).length
  }, [data])

  const rows = useMemo(
    () =>
      filter === 'all'
        ? (data?.rows ?? [])
        : (data?.rows ?? []).filter((row) => row.action === filter),
    [data, filter],
  )

  const columns: Column<Row>[] = [
    {
      key: 'action',
      header: 'Action',
      render: (row) => (
        <Pill status={ACTION_PILL[row.action]}>{ACTION_LABEL[row.action]}</Pill>
      ),
    },
    {
      key: 'child_name',
      header: 'Child',
      value: (row) => row.child_name ?? '',
      render: (row) => (
        <span className="font-bold text-ink-900">
          {row.child_name || 'Unnamed row'}
        </span>
      ),
    },
    { key: 'school_raw', header: 'School', value: (row) => row.school_raw ?? '' },
    {
      key: 'grade_raw',
      header: 'Grade',
      value: (row) => row.grade_raw ?? '',
      secondary: true,
    },
    {
      key: 'source_row',
      header: 'Sheet row',
      value: (row) => row.source_row ?? 0,
      secondary: true,
      render: (row) => (
        <span className="text-ink-500">
          {row.source_sheet} · {row.source_row}
        </span>
      ),
    },
    {
      key: 'summary',
      header: 'Detail',
      value: (row) => row.notices[0]?.message ?? '',
      render: (row) => {
        const blocker = row.notices.find((n) => n.level === 'error')
        if (blocker)
          return <span className="text-berry-600">{blocker.message}</span>
        if (row.changes.length > 0)
          return (
            <span className="text-ink-600">
              {row.changes.length} change{row.changes.length === 1 ? '' : 's'}
            </span>
          )
        const warning = row.notices.find((n) => n.level === 'warning')
        if (warning) return <span className="text-ink-500">{warning.message}</span>
        return <span className="text-ink-400">—</span>
      },
    },
  ]

  /* ── Already imported ─────────────────────────────────────────────── */

  if (result) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
          Roster imported
        </h1>
        <Card className="mb-4 p-6">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                ['New children', result.created],
                ['Updated', result.updated],
                ['No change', result.unchanged],
                ['Withdrawn', result.withdrawn],
              ] as const
            ).map(([text, value]) => (
              <div key={text} className="rounded-2xl bg-canvas-100 p-4">
                <dd className="text-[1.6rem] leading-none font-extrabold text-ink-900">
                  {value}
                </dd>
                <dt className="mt-1 text-[0.8rem] font-semibold text-ink-500">
                  {text}
                </dt>
              </div>
            ))}
          </dl>

          {result.blocked + result.skipped > 0 && (
            <p className="mt-4 rounded-2xl bg-sun-50 px-4 py-3 text-[0.88rem] font-medium text-ink-700">
              {plural(result.blocked + result.skipped, 'row was', 'rows were')} not
              imported. Fix them in the spreadsheet and upload it again — the
              children that did import will simply show as unchanged.
            </p>
          )}

          {!!result.classes && (
            <p className="mt-4 rounded-2xl bg-canvas-100 px-4 py-3 text-[0.88rem] font-medium text-ink-700">
              <strong className="font-extrabold text-ink-900">
                {plural(result.classes, 'activity is', 'activities are')}
              </strong>{' '}
              now in the catalog, with{' '}
              <strong className="font-extrabold text-ink-900">
                {plural(result.class_enrolments ?? 0, 'child', 'children')}
              </strong>{' '}
              signed up across them. Give each one a room and a counselor on the
              Classes and Staff screens.
            </p>
          )}

          {!!result.class_warnings?.length && (
            <div className="mt-4 rounded-2xl bg-sun-50 px-4 py-3 text-[0.88rem] font-medium text-ink-700">
              <p className="font-extrabold text-ink-800">
                The file disagrees with hours already set here. Yours were kept:
              </p>
              <ul className="mt-1 list-disc pl-5">
                {result.class_warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Said plainly because it is a decision, not an oversight: the
              accounts exist so a child has a parent to hang on, and inviting a
              hundred families is something someone does on purpose. */}
          <p className="mt-4 text-[0.88rem] font-medium text-ink-600">
            <strong className="font-extrabold text-ink-800">
              {plural(
                result.parent_accounts_created,
                'parent account was',
                'parent accounts were',
              )}
            </strong>{' '}
            created. Nobody has been emailed — send the invitations from Parents
            when you are ready.
          </p>
        </Card>

        <Button variant="outline" onClick={() => setResult(null)}>
          Import another file
        </Button>
      </div>
    )
  }

  /* ── Reviewing a staged file ──────────────────────────────────────── */

  if (batchId !== null) {
    const blocked = data?.totals.actions?.blocked ?? 0

    return (
      <div className="mx-auto w-full max-w-6xl">
        {detail && <RowDetail row={detail} onClose={() => setDetail(null)} />}

        <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
          Review this import
        </h1>
        <p className="mb-6 text-[0.9rem] font-medium text-ink-500">
          {data?.filename} · nothing has been changed yet.
        </p>

        {preview.isPending || !data ? (
          <Card className="p-6">
            <p className="text-[0.9rem] font-semibold text-ink-400">Reading…</p>
          </Card>
        ) : (
          <>
            <SummaryTiles totals={data.totals} />

            {unresolved.length > 0 && (
              <UnresolvedSchools
                aliases={unresolved}
                schools={schools.data ?? []}
                onResolved={() => {
                  queryClient.invalidateQueries({ queryKey: ['admin', 'schools'] })
                  preview.refetch()
                }}
              />
            )}

            {stale > 0 && (
              <Card className="mb-4 p-5">
                <p className="text-[0.95rem] font-bold text-ink-800">
                  {plural(stale, 'row is', 'rows are')} still held back by a
                  school you have now answered.
                </p>
                <p className="mt-1 mb-3 text-[0.88rem] font-medium text-ink-600">
                  This preview was worked out before that answer. Read the file
                  again to pick it up.
                </p>
                {file ? (
                  <Button
                    loading={recheck.isPending}
                    onClick={() => recheck.mutate()}
                  >
                    Read the file again
                  </Button>
                ) : (
                  <p className="text-[0.88rem] font-semibold text-ink-500">
                    Discard this import and upload the file again — the page was
                    reloaded, so the browser no longer has it.
                  </p>
                )}
              </Card>
            )}

            <div className="mb-3 flex flex-wrap gap-2">
              {(['all', ...ACTIONS] as const).map((key) => {
                const count =
                  key === 'all'
                    ? data.rows.length
                    : (data.totals.actions?.[key] ?? 0)
                if (key !== 'all' && count === 0) return null
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilter(key)}
                    className={`rounded-full px-3.5 py-1.5 text-[0.85rem] font-bold transition-colors ${
                      filter === key
                        ? 'bg-sky-500 text-white'
                        : 'bg-white text-ink-600 shadow-soft hover:bg-canvas-100'
                    }`}
                  >
                    {key === 'all' ? 'All' : ACTION_LABEL[key]} ({count})
                  </button>
                )
              })}
            </div>

            <DataTable
              rows={rows}
              columns={columns}
              searchPlaceholder="Search this file…"
              emptyTitle="No rows"
              emptyBody="Nothing in the file matches that filter."
              onRowClick={setDetail}
              pageSize={50}
            />

            {error && (
              <p className="mt-4 text-[0.9rem] font-semibold text-berry-600">
                {error}
              </p>
            )}

            <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
              <Button
                variant="ghost"
                loading={discard.isPending}
                onClick={() => discard.mutate()}
              >
                Discard
              </Button>
              <Button
                loading={commit.isPending}
                onClick={() => {
                  // Blocked rows are skipped, not fatal — holding a hundred and
                  // fifty children hostage to one unreadable cell helps nobody.
                  // Saying how many, before the click, is the honest middle.
                  if (
                    blocked > 0 &&
                    !window.confirm(
                      `${blocked} row${blocked === 1 ? '' : 's'} cannot be imported and will be skipped. Import the rest?`,
                    )
                  )
                    return
                  commit.mutate()
                }}
              >
                Import {(data.totals.actions?.create ?? 0) +
                  (data.totals.actions?.update ?? 0)}{' '}
                children
              </Button>
            </div>
          </>
        )}
      </div>
    )
  }

  /* ── Nothing staged ───────────────────────────────────────────────── */

  const pending = (batches.data ?? []).filter((b) => b.status === 'preview')

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Import roster
      </h1>

      <Card className="mb-4 p-6">
        <p className="mb-5 rounded-2xl bg-canvas-100 p-4 text-[0.9rem] font-medium text-ink-700">
          Nothing is changed by uploading. You will see exactly what the file
          would do — who is new, who changed, who cannot be read — and decide
          then.
        </p>

        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-canvas-200 px-6 py-10 text-center transition-colors hover:bg-canvas-100">
          <Upload className="size-7 text-ink-400" strokeWidth={1.8} />
          <span className="font-bold text-ink-800">
            {file ? file.name : 'Choose the roster spreadsheet'}
          </span>
          <span className="text-[0.85rem] text-ink-500">
            Excel (.xlsx, .xlsm) — the importer reads the sheet layout, which a
            CSV does not carry
          </span>
          <input
            type="file"
            accept=".xlsx,.xlsm"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
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
            {upload.isPending ? 'Reading…' : 'Read the file'}
          </Button>
        </div>
      </Card>

      {pending.length > 0 && (
        <Card className="mb-4 p-5">
          <p className="mb-3 text-[0.95rem] font-bold text-ink-800">
            {pending.length} upload{pending.length === 1 ? '' : 's'} you never
            finished
          </p>
          <ul className="flex flex-col gap-2">
            {pending.map((batch) => (
              <li key={batch.id} className="flex items-center gap-3">
                <FileSpreadsheet
                  className="size-4 shrink-0 text-ink-400"
                  strokeWidth={2}
                />
                <span className="text-[0.88rem] font-semibold text-ink-800">
                  {batch.filename}
                </span>
                <span className="text-[0.82rem] text-ink-500">
                  {when(batch.uploaded_at)}
                </span>
                <span className="ml-auto">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setBatchId(batch.id)
                      setFilter('all')
                    }}
                  >
                    Review
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {batches.isPending ? null : (batches.data ?? []).length === 0 ? (
        <Card>
          <EmptyState
            icon={<FileSpreadsheet className="size-7" strokeWidth={1.8} />}
            title="No imports yet"
            body="Once you upload a roster, every import shows up here with what it changed."
          />
        </Card>
      ) : (
        <History batches={batches.data ?? []} />
      )}
    </div>
  )
}
