import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  UserPlus,
  Copy,
  Link as LinkIcon,
  MailCheck,
  Pencil,
  Plus,
  Send,
  Trash2,
  X,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { confirmDelete, notifyError } from '@/lib/confirm'
import { Button, Card, Field, Pill } from '@/components/ui'

/* ── Add a person ────────────────────────────────────────────────────── */

export type NewPerson = { name: string; email: string; school_ids?: number[] }

/**
 * One form for parents, counselors and admins. They differ only in whether
 * schools can be assigned at creation, which is worth a prop rather than
 * three near-identical forms that drift apart.
 */
/**
 * A minted setup link, on screen and copyable.
 *
 * Shared by the "Get link" button and by the add-a-parent form, so the link
 * looks and behaves the same whether you asked for it or were handed it.
 */
export function SetupLinkBox({ url }: { url: string }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      // Clipboard access is denied outside a secure context. The link is on
      // screen and selectable either way, so this is not worth an error.
      setCopied(false)
    }
  }

  return (
    <span className="flex flex-col items-end gap-1.5">
      <span className="max-w-xs break-all rounded-lg bg-canvas-100 p-2 text-left font-mono text-[0.7rem] text-ink-700">
        {url}
      </span>
      <span className="flex items-center gap-2">
        <span className="text-[0.72rem] font-semibold text-ink-400">
          Works once · 7 days
        </span>
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          <Copy className="size-3.5" strokeWidth={2.4} />
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </span>
    </span>
  )
}

export function AddPersonForm({
  title,
  endpoint,
  invalidate,
  schools,
  submitLabel = 'Add and send invitation',
  onDone,
}: {
  title: string
  endpoint: string
  invalidate: string[]
  /** When given, the form offers school assignment (counselors only). */
  schools?: { id: number; name: string }[]
  /**
   * Creating a counselor or an admin emails them; creating a parent does not
   * — server/app.py sends parent invitations only when an admin asks for them
   * explicitly. The button used to promise an invitation in all three cases,
   * so adding a parent looked like it had sent one and the admin waited for an
   * email that was never going to arrive.
   */
  submitLabel?: string
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [picked, setPicked] = useState<number[]>([])
  const [error, setError] = useState('')
  const [created, setCreated] = useState<{ url: string; email: string } | null>(null)

  const create = useMutation({
    mutationFn: () =>
      api<{ id: number; email: string; setup_url?: string }>(endpoint, {
        method: 'POST',
        body: {
          name,
          email,
          ...(schools ? { school_ids: picked } : {}),
        },
      }),
    onSuccess: (d) => {
      void qc.invalidateQueries({ queryKey: invalidate })
      // A parent's create response carries their setup link, because nothing
      // was emailed. Hold the form open and show it: this is the one moment
      // the admin is certain to be looking, and closing would hide the only
      // way this person gets in when mail is off.
      if (d.setup_url) {
        setCreated({ url: d.setup_url, email: d.email ?? email })
        setName('')
        setEmail('')
        setPicked([])
        return
      }
      onDone()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not add them.'),
  })

  if (created) {
    return (
      <Card className="mb-4 p-4">
        <p className="mb-1 font-extrabold text-ink-800">
          Added {created.email}
        </p>
        <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
          No email was sent. Send them this link and they can set their own
          password — or use Invite in the table to email it instead.
        </p>
        <div className="flex justify-end">
          <SetupLinkBox url={created.url} />
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="ghost" onClick={() => setCreated(null)}>
            Add another
          </Button>
          <Button variant="ghost" onClick={onDone}>
            Done
          </Button>
        </div>
      </Card>
    )
  }

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-extrabold text-ink-800">{title}</p>
        <button
          type="button"
          aria-label="Cancel"
          onClick={onDone}
          className="flex size-8 items-center justify-center rounded-full text-ink-400 hover:bg-canvas-100"
        >
          <X className="size-4" strokeWidth={2.4} />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <Field
          label="Email"
          type="email"
          inputMode="email"
          hint="Where their invitation is sent."
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      {schools && (
        <div className="mt-3">
          <p className="mb-1.5 text-sm font-bold text-ink-700">Schools</p>
          {schools.length === 0 ? (
            <p className="text-[0.85rem] font-medium text-ink-500">
              No schools yet — add one first, or assign them later.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {schools.map((s) => {
                const on = picked.includes(s.id)
                return (
                  <button
                    key={s.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setPicked((p) =>
                        on ? p.filter((i) => i !== s.id) : [...p, s.id],
                      )
                    }
                    className={`rounded-full border-2 px-3.5 py-1.5 text-[0.88rem] font-bold transition ${
                      on
                        ? 'border-sky-500 bg-sky-50 text-sky-700'
                        : 'border-canvas-200 bg-white text-ink-500'
                    }`}
                  >
                    {s.name}
                  </button>
                )
              })}
            </div>
          )}
          {/* An unassigned counselor sees an empty roster and cannot take
              attendance at all, so it's worth saying rather than discovering. */}
          {schools.length > 0 && picked.length === 0 && (
            <p className="mt-2 text-[0.82rem] font-semibold text-sun-600">
              Without a school they will see an empty roster.
            </p>
          )}
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          disabled={!name.trim() || !email.trim()}
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          {submitLabel}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

/* ── Resend one invitation ───────────────────────────────────────────── */

export function ResendInvite({
  endpoint,
  label = 'Resend invite',
}: {
  endpoint: string
  label?: string
}) {
  const [note, setNote] = useState<'sent' | 'failed' | null>(null)
  const send = useMutation({
    mutationFn: () => api(endpoint, { method: 'POST', body: {} }),
    onSuccess: () => setNote('sent'),
    onError: () => setNote('failed'),
  })

  if (note === 'sent') {
    return (
      <span className="inline-flex items-center gap-1.5 text-[0.82rem] font-bold text-leaf-600">
        <MailCheck className="size-4" strokeWidth={2.4} />
        Sent
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        loading={send.isPending}
        onClick={() => send.mutate()}
      >
        <Send className="size-3.5" strokeWidth={2.4} />
        {label}
      </Button>
      {note === 'failed' && (
        <span className="text-[0.8rem] font-bold text-berry-600">Failed</span>
      )}
    </span>
  )
}

/* ── A setup link, instead of an invitation email ────────────────────── */

/**
 * Hands back the one-time link that lets someone set their own password.
 *
 * The invitation email already carries exactly this link — but with no mail
 * provider configured it is generated, discarded, and reported as sent, which
 * leaves a JCC unable to onboard any staff and with nothing on screen saying
 * why. Showing the link is the same answer the superadmin console gives when
 * it creates a JCC's first admin, for the same reason.
 */
export function SetupLink({ endpoint }: { endpoint: string }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api<{ setup_url: string; expires_in_days: number }>(endpoint, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (d) => {
      setUrl(d.setup_url)
      setError('')
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not create a link.'),
  })

  if (url) return <SetupLinkBox url={url} />

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="ghost"
        loading={create.isPending}
        onClick={() => create.mutate()}
      >
        <LinkIcon className="size-3.5" strokeWidth={2.4} />
        Get link
      </Button>
      {error && (
        <span className="text-[0.8rem] font-bold text-berry-600">{error}</span>
      )}
    </span>
  )
}

/* ── Give a parent a child ───────────────────────────────────────────── */

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'] as const

/**
 * Enrol a child under an existing parent.
 *
 * The endpoint has always been there; nothing in the app called it, so a parent
 * added by hand stayed childless with no way to fix it short of the roster
 * importer or the legacy admin.
 *
 * That is not only a gap in the roster. A childless parent is invisible to
 * every broadcast — `_resolve_message_recipients` resolves an audience through
 * `children`, even for "everyone" — so they can be written to individually and
 * never hear an announcement. The symptom shows up in Communications and the
 * cause is here.
 */
export function AddChild({
  parentId,
  parentName,
  schools,
}: {
  parentId: number
  parentName: string
  schools: { id: number; name: string }[]
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [schoolId, setSchoolId] = useState<number | ''>('')
  const [days, setDays] = useState<string[]>([...WEEKDAYS])
  const [error, setError] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api('/api/admin/children', {
        method: 'POST',
        body: {
          name: name.trim(),
          parent_id: parentId,
          school_id: schoolId,
          days,
        },
      }),
    onSuccess: () => {
      setOpen(false)
      setName('')
      setDays([...WEEKDAYS])
      setError('')
      // The parents table renders each family's children inline, and Children
      // is the same roster from the other side.
      void qc.invalidateQueries({ queryKey: ['admin', 'parents'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'children'] })
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not add that child.'),
  })

  if (!open) {
    return (
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <UserPlus className="size-3.5" strokeWidth={2.4} />
        Add child
      </Button>
    )
  }

  return (
    <Card className="w-full max-w-md p-4 text-left">
      <p className="mb-3 font-extrabold text-ink-800">
        Add a child for {parentName}
      </p>

      <Field
        label="Child's full name"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-3"
      />

      <label className="mb-1.5 block text-sm font-bold text-ink-700">
        School
      </label>
      {schools.length === 0 ? (
        <p className="mb-3 text-[0.85rem] font-semibold text-sun-600">
          There are no schools yet — add one under Schools first.
        </p>
      ) : (
        <select
          value={schoolId}
          onChange={(e) => setSchoolId(Number(e.target.value) || '')}
          aria-label="School"
          className="mb-3 w-full rounded-2xl border-2 border-canvas-200 px-3 py-2 text-[0.9rem] font-semibold text-ink-900 outline-none focus:border-sky-500"
        >
          <option value="">Pick a school…</option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}

      <p className="mb-1.5 text-sm font-bold text-ink-700">Days they attend</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {WEEKDAYS.map((d) => {
          const on = days.includes(d)
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setDays((prev) =>
                  on ? prev.filter((x) => x !== d) : [...prev, d],
                )
              }
              className={`rounded-full border-2 px-3 py-1.5 text-[0.82rem] font-bold transition ${
                on
                  ? 'border-sky-500 bg-sky-50 text-sky-700'
                  : 'border-canvas-200 bg-white text-ink-500'
              }`}
            >
              {d.slice(0, 3)}
            </button>
          )
        })}
      </div>
      {days.length === 0 && (
        // Without a day the child is on the roster but never expected, so no
        // board shows them and the attendance check never asks.
        <p className="mb-3 text-[0.82rem] font-semibold text-sun-600">
          With no days they will not appear on any day's roster.
        </p>
      )}

      {error && (
        <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          disabled={!name.trim() || !schoolId}
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          Add child
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

/* ── Add a child from the roster screen, not a parent's row ─────────────── */

/**
 * Same endpoint as AddChild, but for the Children screen: it starts from a
 * child, not a parent, so the parent is a pick rather than already known.
 * Kept separate from AddChild rather than made to handle both cases — the
 * parent-picker only matters here, and AddChild's contract (you already
 * know who this is for) stays simple for the one place that has that.
 */
export function AddChildForm({
  parents,
  schools,
  onDone,
}: {
  parents: { id: number; name: string; email: string }[]
  schools: { id: number; name: string }[]
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [parentId, setParentId] = useState<number | ''>('')
  const [name, setName] = useState('')
  const [schoolId, setSchoolId] = useState<number | ''>('')
  const [days, setDays] = useState<string[]>([...WEEKDAYS])
  const [error, setError] = useState('')

  const create = useMutation({
    mutationFn: () =>
      api('/api/admin/children', {
        method: 'POST',
        body: {
          name: name.trim(),
          parent_id: parentId,
          school_id: schoolId,
          days,
        },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['admin', 'parents'] })
      void qc.invalidateQueries({ queryKey: ['admin', 'children'] })
      onDone()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not add that child.'),
  })

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-extrabold text-ink-800">Add a child</p>
        <button
          type="button"
          aria-label="Cancel"
          onClick={onDone}
          className="flex size-8 items-center justify-center rounded-full text-ink-400 hover:bg-canvas-100"
        >
          <X className="size-4" strokeWidth={2.4} />
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
          Parent
          {parents.length === 0 ? (
            <p className="text-[0.85rem] font-semibold text-sun-600">
              No parents yet — add one first.
            </p>
          ) : (
            <select
              value={parentId}
              onChange={(e) => setParentId(Number(e.target.value) || '')}
              className="h-10 rounded-2xl border-2 border-canvas-200 bg-white px-3 text-[0.95rem] font-semibold text-ink-900 outline-none focus:border-sky-500"
            >
              <option value="">Pick a parent…</option>
              {parents.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} — {p.email}
                </option>
              ))}
            </select>
          )}
        </label>
        <Field
          label="Child's full name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <label className="mt-3 mb-1.5 block text-sm font-bold text-ink-700">
        School
      </label>
      {schools.length === 0 ? (
        <p className="mb-3 text-[0.85rem] font-semibold text-sun-600">
          There are no schools yet — add one under Schools first.
        </p>
      ) : (
        <select
          value={schoolId}
          onChange={(e) => setSchoolId(Number(e.target.value) || '')}
          aria-label="School"
          className="mb-3 w-full rounded-2xl border-2 border-canvas-200 px-3 py-2 text-[0.9rem] font-semibold text-ink-900 outline-none focus:border-sky-500"
        >
          <option value="">Pick a school…</option>
          {schools.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      )}

      <p className="mb-1.5 text-sm font-bold text-ink-700">Days they attend</p>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {WEEKDAYS.map((d) => {
          const on = days.includes(d)
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              onClick={() =>
                setDays((prev) =>
                  on ? prev.filter((x) => x !== d) : [...prev, d],
                )
              }
              className={`rounded-full border-2 px-3 py-1.5 text-[0.82rem] font-bold transition ${
                on
                  ? 'border-sky-500 bg-sky-50 text-sky-700'
                  : 'border-canvas-200 bg-white text-ink-500'
              }`}
            >
              {d.slice(0, 3)}
            </button>
          )
        })}
      </div>
      {days.length === 0 && (
        <p className="mb-3 text-[0.82rem] font-semibold text-sun-600">
          With no days they will not appear on any day's roster.
        </p>
      )}

      {error && (
        <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          disabled={!name.trim() || !schoolId || !parentId}
          loading={create.isPending}
          onClick={() => create.mutate()}
        >
          Add child
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </Card>
  )
}

/* ── Edit a person's name or email ───────────────────────────────────── */

/**
 * A small icon trigger for the actions column. Rendering the form itself
 * inline here would blow up the row's height inside a `<td>`, so this only
 * opens it — same split the counselors table already uses for "Schools":
 * the trigger lives in the row, the panel renders above the table.
 */
export function EditPersonButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label="Edit"
      onClick={onClick}
      className="flex size-9 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-canvas-100 hover:text-ink-600"
    >
      <Pencil className="size-4" strokeWidth={2.1} />
    </button>
  )
}

/**
 * Rename/re-email panel, for parents, counselors and admins alike.
 *
 * A typo in either field used to mean delete-and-recreate — which for a
 * parent or counselor loses their password, their invitation history, and
 * (for a parent) re-links every child by hand.
 */
export function EditPersonForm({
  endpoint,
  name,
  email,
  what,
  invalidate,
  onClose,
}: {
  endpoint: string
  name: string
  email: string
  /** Named in the heading, so it's clear who this edits. */
  what: string
  invalidate: string[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [newName, setNewName] = useState(name)
  const [newEmail, setNewEmail] = useState(email)
  const [error, setError] = useState('')

  const save = useMutation({
    mutationFn: () =>
      api(endpoint, {
        method: 'PATCH',
        body: { name: newName.trim(), email: newEmail.trim() },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: invalidate })
      onClose()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not save that.'),
  })

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center justify-between">
        <p className="font-extrabold text-ink-800">Edit {what}</p>
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
          label="Full name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <Field
          label="Email"
          type="email"
          inputMode="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
        />
      </div>

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button
          disabled={!newName.trim() || !newEmail.trim()}
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

/* ── Delete a person ─────────────────────────────────────────────────── */

export function DeletePerson({
  endpoint,
  what,
  invalidate,
}: {
  endpoint: string
  /** Named in the confirmation, so nobody deletes the wrong row. */
  what: string
  invalidate: string[]
}) {
  const qc = useQueryClient()
  const remove = useMutation({
    mutationFn: () => api(endpoint, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: invalidate }),
    onError: (e) =>
      notifyError(
        `Could not delete ${what}`,
        e instanceof ApiError ? e.message : undefined,
      ),
  })

  return (
    <button
      type="button"
      aria-label={`Delete ${what}`}
      disabled={remove.isPending}
      onClick={async () => {
        if (await confirmDelete(what)) remove.mutate()
      }}
      className="flex size-9 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-berry-50 hover:text-berry-500 disabled:opacity-40"
    >
      <Trash2 className="size-4" strokeWidth={2.1} />
    </button>
  )
}

/* ── Bulk invitations ────────────────────────────────────────────────── */

type BulkState = {
  status: 'idle' | 'running' | 'done'
  sent: number
  failed: number
  total: number
  failed_emails: { email: string; reason: string }[]
  error: string | null
}

/**
 * Invite every parent who hasn't set a password yet.
 *
 * Progress is polled from the server rather than tracked here, because the
 * job outlives the request and may be running in a different worker.
 */
export function BulkInviteCard() {
  const [note, setNote] = useState('')

  const { data: state } = useQuery({
    queryKey: ['admin', 'bulk-invites'],
    queryFn: () =>
      api<BulkState>('/api/admin/parents/send-all-invites/status'),
    refetchInterval: (q) =>
      q.state.data?.status === 'running' ? 2000 : false,
  })

  const start = useMutation({
    mutationFn: () =>
      api('/api/admin/parents/send-all-invites', { method: 'POST', body: {} }),
    onSuccess: () => setNote(''),
    onError: (e) =>
      setNote(e instanceof ApiError ? e.message : 'Could not start the send.'),
  })

  const running = state?.status === 'running'
  const done = state?.status === 'done'

  return (
    <Card className="mb-4 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-extrabold text-ink-800">Invite every parent</p>
          <p className="text-[0.85rem] font-medium text-ink-500">
            Sends a setup link to every parent who hasn&apos;t created a
            password yet. Already-active parents are skipped.
          </p>
        </div>
        <Button loading={running || start.isPending} onClick={() => start.mutate()}>
          <Send className="size-4" strokeWidth={2.4} />
          {running ? 'Sending…' : 'Send invitations'}
        </Button>
      </div>

      {(running || done) && state && (
        <div className="mt-4 border-t border-canvas-200 pt-3">
          <div className="mb-2 flex items-center gap-3 text-[0.88rem] font-bold">
            <span className="text-leaf-600">{state.sent} sent</span>
            {state.failed > 0 && (
              <span className="text-berry-600">{state.failed} failed</span>
            )}
            <span className="text-ink-400">of {state.total}</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-canvas-200">
            <div
              className="h-full rounded-full bg-sky-500 transition-all"
              style={{
                width: state.total
                  ? `${Math.round(((state.sent + state.failed) / state.total) * 100)}%`
                  : '0%',
              }}
            />
          </div>

          {state.error && (
            <p role="alert" className="mt-2 text-sm font-medium text-berry-600">
              {state.error}
            </p>
          )}

          {/* Naming the addresses that failed is the difference between "some
              didn't work" and knowing exactly who to chase. */}
          {state.failed_emails.length > 0 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-[0.85rem] font-bold text-ink-600">
                {state.failed_emails.length} address
                {state.failed_emails.length === 1 ? '' : 'es'} need a manual
                resend
              </summary>
              <ul className="mt-2 flex flex-col gap-1">
                {state.failed_emails.map((f) => (
                  <li
                    key={f.email}
                    className="text-[0.83rem] font-medium text-ink-500"
                  >
                    <span className="font-bold text-ink-700">{f.email}</span> —{' '}
                    {f.reason}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {note && (
        <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
          {note}
        </p>
      )}
    </Card>
  )
}

/* ── Shared header action ────────────────────────────────────────────── */

export function AddButton({
  open,
  onToggle,
  children,
}: {
  open: boolean
  onToggle: () => void
  children: ReactNode
}) {
  return (
    <Button size="sm" onClick={onToggle}>
      {open ? (
        <X className="size-4" strokeWidth={2.6} />
      ) : (
        <Plus className="size-4" strokeWidth={2.6} />
      )}
      {children}
    </Button>
  )
}

/* ── Invitation status ───────────────────────────────────────────────── */

export function InviteStatus({
  active,
  invitedAt,
}: {
  active: boolean
  invitedAt?: string | null
}) {
  if (active) return <Pill status="leaf">Active</Pill>
  if (invitedAt) {
    const days = Math.floor(
      (Date.now() - new Date(invitedAt).getTime()) / 86_400_000,
    )
    return (
      <Pill status="sun">
        Invited{days > 0 ? ` ${days}d ago` : ' today'}
      </Pill>
    )
  }
  return <Pill status="neutral">Not invited</Pill>
}
