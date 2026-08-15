import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, Plus, Upload, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { DataTable, type Column } from '@/components/DataTable'
import { Button, Card, Field, Pill, Skeleton } from '@/components/ui'
import { legibility, parseHex } from '@/lib/contrast'

export type Organization = {
  id: number
  slug: string
  name: string
  /** Already resolved server-side: the uploaded file if there is one, else the pasted link. */
  logo_url: string | null
  /** True when logo_url came from our bucket, so "Remove" deletes an object rather than clearing a field. */
  logo_uploaded: boolean
  brand_primary: string | null
  brand_accent: string | null
  timezone: string
  status: 'active' | 'suspended'
  modules: Record<string, boolean>
  /** Local part only — the domain is fixed platform-side. Null falls back to the slug. */
  email_from_local: string | null
  email_from_name: string | null
  email_reply_to: string | null
  /** The address that will actually be used, slug fallback already applied. */
  email_from: string | null
  email_sender_domain: string
  parents: number
  children: number
  counselors: number
}

type ModuleDef = { key: string; label: string; default: boolean }

type OrgAdmin = {
  id: number
  email: string
  name: string
  created_at: string
  password_set_at: string | null
}

type NewAdmin = OrgAdmin & { setup_url: string; expires_in_days: number }

type Inventory = Record<string, number>

/** `admins` at 1 → `admin`. The server's keys are all regular plurals except
 *  `children`, which does not end in an s and so the same rule leaves it be. */
function unitOf(label: string, n: number): string {
  const words = label.replace(/_/g, ' ')
  return n === 1 && words.endsWith('s') ? words.slice(0, -1) : words
}

/* ── Danger zone ─────────────────────────────────────────────────────────
 * Deleting an organization removes every row in every table that belongs to
 * it, and there is no undo behind it anywhere.
 *
 * Two things stand in the way on purpose. The counts are fetched and shown
 * first, so the decision is made against what is actually in there rather than
 * against a guess. And the button stays dead until the organization's name is
 * typed exactly — an id in a URL is one keystroke away from a different JCC,
 * and typing the name is the one confirmation that cannot be given by
 * reflex.
 */
function DangerZone({ org, onDeleted }: { org: Organization; onDeleted: () => void }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [error, setError] = useState('')

  const inventory = useQuery({
    queryKey: ['superadmin', 'inventory', org.id],
    queryFn: () => api<Inventory>(`/api/superadmin/organizations/${org.id}/inventory`),
    enabled: open,
  })

  const remove = useMutation({
    mutationFn: () =>
      api(`/api/superadmin/organizations/${org.id}`, {
        method: 'DELETE',
        body: { confirm: typed.trim() },
      }),
    onSuccess: onDeleted,
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'The organization was not deleted.'),
  })

  const rows = Object.entries(inventory.data ?? {}).filter(([, n]) => n > 0)

  return (
    <Card className="p-4">
      <p className="mb-1 font-extrabold text-berry-600">Delete organization</p>
      <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
        Removes the JCC and everything in it. This cannot be undone. Suspending
        above is the reversible option.
      </p>

      {!open ? (
        <Button variant="outline" full onClick={() => setOpen(true)}>
          Delete {org.name}…
        </Button>
      ) : (
        <>
          {inventory.isPending ? (
            <Skeleton className="mb-3 h-16" />
          ) : rows.length > 0 ? (
            <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 rounded-2xl bg-berry-50 p-3 text-[0.85rem] font-medium text-ink-700">
              {rows.map(([label, n]) => (
                <li key={label}>
                  <strong className="font-extrabold">{n}</strong>{' '}
                  {unitOf(label, n)}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mb-3 rounded-2xl bg-canvas-100 p-3 text-[0.85rem] font-medium text-ink-600">
              This organization is empty.
            </p>
          )}

          {/* Photographs are objects in Supabase Storage, not rows. Saying so
              here because it is the one part a superadmin cannot verify from
              this screen afterwards. */}
          {(inventory.data?.photos ?? 0) > 0 && (
            <p className="mb-3 text-[0.82rem] font-medium text-ink-500">
              The {inventory.data?.photos} photographs are stored outside the
              database. Their paths are kept in the deletion record so anything
              that fails to delete can still be found.
            </p>
          )}

          <Field
            label={`Type ${org.name} to confirm`}
            value={typed}
            autoComplete="off"
            onChange={(e) => {
              setTyped(e.target.value)
              setError('')
            }}
          />

          {error && (
            <p className="mt-2 text-[0.85rem] font-semibold text-berry-600">{error}</p>
          )}

          <div className="mt-3 flex gap-2">
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false)
                setTyped('')
                setError('')
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              className="flex-1"
              disabled={typed.trim() !== org.name}
              loading={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Delete permanently
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

/**
 * One brand colour: a native colour wheel, the hex beside it, and the truth
 * about whether it can carry a button label.
 *
 * `<input type="color">` is the wheel — the OS picker, with an eyedropper on
 * every desktop browser, which beats anything hand-rolled. It only ever holds
 * a valid `#rrggbb`, so the text field stays: pasting a hex from a brand guide
 * is how this actually gets used, and the wheel cannot be pasted into.
 */
function ColourField({
  label,
  value,
  fallback,
  onChange,
}: {
  label: string
  value: string
  fallback: string
  onChange: (next: string) => void
}) {
  const effective = parseHex(value) ? value : fallback
  const reading = legibility(effective)
  const malformed = value.trim() !== '' && !parseHex(value)

  return (
    <div>
      <label className="mb-1.5 block text-sm font-bold text-ink-700">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          aria-label={`${label} colour picker`}
          value={effective}
          onChange={(e) => onChange(e.target.value)}
          className="size-10 shrink-0 cursor-pointer rounded-lg border-2 border-canvas-200 bg-white p-0.5"
        />
        <input
          aria-label={`${label} hex`}
          value={value}
          placeholder={fallback}
          spellCheck={false}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border-2 border-canvas-200 px-3 py-2 font-mono text-[0.85rem] text-ink-800 outline-none focus:border-sky-500"
        />
      </div>

      {malformed && (
        <p className="mt-1.5 text-[0.78rem] font-semibold text-berry-600">
          Needs six hex digits, like {fallback}.
        </p>
      )}

      {/* The preview is a real button in the real colour, not a swatch. A
          swatch answers "what colour is this"; the question that matters is
          "can a counselor read the label at arm's length". */}
      {reading && !malformed && (
        <div className="mt-2 flex items-center gap-2">
          <span
            className="rounded-lg px-3 py-1.5 text-[0.8rem] font-bold"
            style={{
              background: effective,
              color: reading.prefer === 'white' ? '#ffffff' : '#101828',
            }}
          >
            Button
          </span>
          <span className="text-[0.72rem] font-semibold text-ink-400">
            {Math.max(reading.onWhite, reading.onInk).toFixed(1)}:1
          </span>
        </div>
      )}

      {/* Never a block on saving. It is their brand; the console's job is to
          say what will happen, not to overrule it. */}
      {reading?.unusable && !malformed && (
        <p className="mt-1.5 text-[0.78rem] font-semibold text-sun-600">
          Low contrast either way — a label on this fill will be hard to read.
        </p>
      )}
      {reading && !reading.unusable && reading.prefer === 'ink' && !malformed && (
        <p className="mt-1.5 text-[0.78rem] font-medium text-ink-500">
          Light colour — the app puts white text on this, which will be faint.
        </p>
      )}
    </div>
  )
}

/**
 * The logo: upload a file we hold, or fall back to a link we do not.
 *
 * Uploading is the path that should be taken. A pasted URL points at the JCC's
 * own web server, so it breaks silently when they redesign their site and it
 * contacts a third party on every screen of our app. It stays available
 * because it costs one field and it is occasionally the only thing someone has
 * to hand.
 */
function OrgLogoCard({ org }: { org: Organization }) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [url, setUrl] = useState(org.logo_uploaded ? '' : (org.logo_url ?? ''))
  const fileRef = useRef<HTMLInputElement>(null)

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ['superadmin', 'organizations'] })

  const upload = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData()
      form.append('logo', file)
      return api(`/api/superadmin/organizations/${org.id}/logo`, {
        method: 'POST',
        body: form,
      })
    },
    onSuccess: () => {
      setError('')
      invalidate()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not upload that.'),
  })

  const remove = useMutation({
    mutationFn: () =>
      api(`/api/superadmin/organizations/${org.id}/logo`, { method: 'DELETE' }),
    onSuccess: () => {
      setError('')
      invalidate()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not remove it.'),
  })

  const saveUrl = useMutation({
    mutationFn: () =>
      api(`/api/superadmin/organizations/${org.id}`, {
        method: 'PATCH',
        body: { logo_url: url.trim() || null },
      }),
    onSuccess: () => {
      setError('')
      invalidate()
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  })

  return (
    <Card className="p-4">
      <p className="mb-1 font-extrabold text-ink-800">Logo</p>
      <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
        Replaces the Kikar wordmark everywhere this organization's people look,
        and appears in their invitation email. Not on the sign-in screen — until
        someone signs in, the app does not know which JCC they belong to.
      </p>

      {/* Checkerboard, because most logos are transparent PNGs and a white
          preview hides a white-on-transparent mark completely. */}
      <div
        className="mb-3 flex min-h-20 items-center justify-center rounded-xl border-2 border-dashed border-canvas-200 p-3"
        style={{
          backgroundImage:
            'linear-gradient(45deg,#f1f3f6 25%,transparent 25%,transparent 75%,#f1f3f6 75%),linear-gradient(45deg,#f1f3f6 25%,transparent 25%,transparent 75%,#f1f3f6 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 8px 8px',
        }}
      >
        {org.logo_url ? (
          <img
            src={org.logo_url}
            alt={`${org.name} logo`}
            className="max-h-14 w-auto max-w-full object-contain"
          />
        ) : (
          <span className="text-[0.8rem] font-semibold text-ink-400">
            No logo — the Kikar wordmark is shown
          </span>
        )}
      </div>

      <input
        ref={fileRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) upload.mutate(file)
          // Cleared so picking the same file twice still fires a change.
          e.target.value = ''
        }}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          loading={upload.isPending}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="size-4" strokeWidth={2.4} />
          {org.logo_uploaded ? 'Replace' : 'Upload'}
        </Button>
        {org.logo_uploaded && (
          <Button
            variant="ghost"
            loading={remove.isPending}
            onClick={() => remove.mutate()}
          >
            Remove
          </Button>
        )}
      </div>
      <p className="mt-2 text-[0.75rem] font-medium text-ink-400">
        PNG, JPG, WEBP or SVG · up to 2 MB · a wide mark on a transparent
        background sits best in the bar
      </p>

      {!org.logo_uploaded && (
        <details className="mt-3">
          <summary className="cursor-pointer text-[0.8rem] font-semibold text-ink-500">
            Or link to an image hosted elsewhere
          </summary>
          <div className="mt-2 flex items-end gap-2">
            <Field
              label="Logo URL"
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              hint="Breaks if their site changes. Uploading is better."
              className="flex-1"
            />
            <Button
              variant="outline"
              loading={saveUrl.isPending}
              onClick={() => saveUrl.mutate()}
            >
              Save
            </Button>
          </div>
        </details>
      )}

      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}
    </Card>
  )
}

/** Mirrors tenancy.EMAIL_LOCAL_PART_RE and the CHECK constraint behind it.
 *  Client-side only to explain the rule while typing — the server rejects a
 *  bad value regardless of what this says. */
const LOCAL_PART = /^[a-z0-9]([a-z0-9._-]{0,62}[a-z0-9])?$/

function OutgoingMail({ org }: { org: Organization }) {
  const qc = useQueryClient()
  const [local, setLocal] = useState(org.email_from_local ?? '')
  const [fromName, setFromName] = useState(org.email_from_name ?? '')
  const [replyTo, setReplyTo] = useState(org.email_reply_to ?? '')
  const [error, setError] = useState('')

  // Same key Administrators uses, so this is served from cache rather than
  // being a second request for the same list.
  const admins = useQuery({
    queryKey: ['superadmin', 'organizations', org.id, 'admins'],
    queryFn: () => api<OrgAdmin[]>(`/api/superadmin/organizations/${org.id}/admins`),
  })

  const effectiveLocal = (local.trim() || org.slug).toLowerCase()
  const localValid = LOCAL_PART.test(effectiveLocal)

  const save = useMutation({
    mutationFn: () =>
      api(`/api/superadmin/organizations/${org.id}`, {
        method: 'PATCH',
        body: {
          email_from_local: local.trim().toLowerCase() || null,
          email_from_name: fromName.trim() || null,
          email_reply_to: replyTo.trim() || null,
        },
      }),
    onSuccess: () => {
      setError('')
      void qc.invalidateQueries({ queryKey: ['superadmin', 'organizations'] })
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  })

  return (
    <Card className="p-4">
      <p className="mb-1 font-extrabold text-ink-800">Outgoing email</p>
      <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
        How invitations and password resets appear in a parent's inbox. Leave
        these empty and the organization still sends correctly — the address
        falls back to the slug and the name to the organization's.
      </p>

      <Field
        label="Sender"
        placeholder={org.slug}
        value={local}
        onChange={(e) => setLocal(e.target.value)}
        hint={`The part before the @ only. The domain is always @${org.email_sender_domain} — it is the domain verified with our email provider, and mail from anywhere else is rejected before it sends.`}
        error={localValid ? undefined : 'Lowercase letters, numbers, dots, hyphens and underscores.'}
        className="mb-3"
      />

      <Field
        label="Display name"
        placeholder={org.name}
        value={fromName}
        onChange={(e) => setFromName(e.target.value)}
        className="mb-3"
      />

      <Field
        label="Reply-to"
        type="email"
        placeholder="who should receive replies"
        value={replyTo}
        onChange={(e) => setReplyTo(e.target.value)}
        list={`replyto-${org.id}`}
        hint="Without one, parents replying to an invitation reach nobody."
        className="mb-2"
      />
      <datalist id={`replyto-${org.id}`}>
        {(admins.data ?? []).map((a) => (
          <option key={a.id} value={a.email} />
        ))}
      </datalist>
      {(admins.data ?? []).length > 0 && (
        <div className="mb-3 flex flex-wrap gap-1.5">
          {(admins.data ?? []).map((a) => (
            <button
              key={a.id}
              type="button"
              onClick={() => setReplyTo(a.email)}
              className="rounded-full bg-canvas-100 px-2.5 py-1 text-[0.78rem] font-semibold text-ink-600 hover:bg-canvas-200"
            >
              {a.email}
            </button>
          ))}
        </div>
      )}

      <div className="mb-3 rounded-lg bg-canvas-100 p-3">
        <p className="mb-1 text-[0.72rem] font-bold uppercase tracking-wide text-ink-400">
          Parents will see
        </p>
        <p className="break-all text-[0.88rem] font-semibold text-ink-800">
          {fromName.trim() || org.name} &lt;{effectiveLocal}@{org.email_sender_domain}&gt;
        </p>
        {replyTo.trim() && (
          <p className="mt-1 break-all text-[0.82rem] font-medium text-ink-500">
            Replies go to {replyTo.trim()}
          </p>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}
      <Button
        full
        loading={save.isPending}
        disabled={!localValid}
        onClick={() => save.mutate()}
      >
        Save email settings
      </Button>
    </Card>
  )
}

/* ── Administrators ──────────────────────────────────────────────────────
 * A new organization has no way in until someone here has an account: the
 * admin screens take the organization from the caller's own token, so a
 * superadmin cannot make one from inside the JCC. Before this, opening a new
 * JCC meant an INSERT by hand against the database.
 *
 * No password is ever set or shown. The server returns a one-time setup link
 * and this shows it once, because the first account of a JCC usually exists
 * before that JCC's email is configured.
 */
function Administrators({ org }: { org: Organization }) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [created, setCreated] = useState<NewAdmin | null>(null)
  const [copied, setCopied] = useState(false)

  const key = ['superadmin', 'organizations', org.id, 'admins']
  const admins = useQuery({
    queryKey: key,
    queryFn: () => api<OrgAdmin[]>(`/api/superadmin/organizations/${org.id}/admins`),
  })

  const create = useMutation({
    mutationFn: () =>
      api<NewAdmin>(`/api/superadmin/organizations/${org.id}/admins`, {
        method: 'POST',
        body: { name: name.trim(), email: email.trim() },
      }),
    onSuccess: (admin) => {
      setError('')
      setCreated(admin)
      setCopied(false)
      setName('')
      setEmail('')
      void qc.invalidateQueries({ queryKey: key })
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not create that administrator.'),
  })

  const copy = async () => {
    if (!created) return
    try {
      await navigator.clipboard.writeText(created.setup_url)
      setCopied(true)
    } catch {
      // Clipboard access is denied outside a secure context; the link is on
      // screen and selectable either way, so this is not worth an error.
      setCopied(false)
    }
  }

  return (
    <Card className="p-4">
      <p className="mb-1 font-extrabold text-ink-800">Administrators</p>
      <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
        A new organization cannot be signed into until it has one.
      </p>

      {admins.isLoading ? (
        <Skeleton className="h-10" />
      ) : admins.data && admins.data.length > 0 ? (
        <ul className="mb-3 flex flex-col divide-y divide-canvas-200">
          {admins.data.map((a) => (
            <li key={a.id} className="flex items-center justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="truncate text-[0.92rem] font-bold text-ink-700">{a.name}</p>
                <p className="truncate text-[0.82rem] font-medium text-ink-400">
                  {a.email}
                </p>
              </div>
              <Pill status={a.password_set_at ? 'leaf' : 'sun'}>
                {a.password_set_at ? 'Active' : 'Invited'}
              </Pill>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mb-3 text-[0.85rem] font-semibold text-berry-600">
          No administrator yet — nobody can open this organization.
        </p>
      )}

      {created && (
        <div className="mb-3 rounded-xl border border-canvas-200 bg-canvas-100 p-3">
          <p className="text-[0.85rem] font-bold text-ink-800">
            Send this link to {created.email}
          </p>
          <p className="mb-2 text-[0.8rem] font-medium text-ink-500">
            It sets their password, works once, and expires in{' '}
            {created.expires_in_days} days. It is not shown again.
          </p>
          <p className="mb-2 break-all rounded-lg bg-canvas-50 p-2 font-mono text-[0.75rem] text-ink-700">
            {created.setup_url}
          </p>
          <Button full variant="ghost" onClick={() => void copy()}>
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        </div>
      )}

      <Field
        label="Name"
        placeholder="Heather"
        value={name}
        onChange={(e) => setName(e.target.value)}
        className="mb-3"
      />
      <Field
        label="Email"
        type="email"
        placeholder="admin@jcc.org"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mb-3"
      />
      {error && (
        <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}
      <Button
        full
        loading={create.isPending}
        disabled={!name.trim() || !email.trim()}
        onClick={() => create.mutate()}
      >
        Add administrator
      </Button>
    </Card>
  )
}

/* ── Detail panel ────────────────────────────────────────────────────── */

function OrgPanel({
  org,
  modules,
  onClose,
}: {
  org: Organization
  modules: ModuleDef[]
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [name, setName] = useState(org.name)
  const [nameError, setNameError] = useState('')
  const [primary, setPrimary] = useState(org.brand_primary ?? '')
  const [accent, setAccent] = useState(org.brand_accent ?? '')
  const [error, setError] = useState('')

  const invalidate = () =>
    void qc.invalidateQueries({ queryKey: ['superadmin', 'organizations'] })

  // Separate from colours: a bad hex is a formatting mistake, a blank name
  // is a different kind of thing to stop someone from saving.
  const saveName = useMutation({
    mutationFn: () =>
      api(`/api/superadmin/organizations/${org.id}`, {
        method: 'PATCH',
        body: { name: name.trim() },
      }),
    onSuccess: () => {
      setNameError('')
      invalidate()
    },
    onError: (e) =>
      setNameError(e instanceof ApiError ? e.message : 'Could not save.'),
  })

  // Colours only. The logo moved to OrgLogoCard, which owns both an upload and
  // the URL fallback — bundling a file upload into the same Save as two hex
  // fields made "Save branding" mean two different kinds of thing.
  const saveBrand = useMutation({
    mutationFn: () =>
      api(`/api/superadmin/organizations/${org.id}`, {
        method: 'PATCH',
        body: {
          brand_primary: primary || null,
          brand_accent: accent || null,
        },
      }),
    onSuccess: () => {
      setError('')
      invalidate()
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  })

  const toggleModule = useMutation({
    mutationFn: (next: Record<string, boolean>) =>
      api(`/api/superadmin/organizations/${org.id}/modules`, {
        method: 'PUT',
        body: { modules: next },
      }),
    onSuccess: invalidate,
  })

  const setStatus = useMutation({
    mutationFn: (status: 'active' | 'suspended') =>
      api(`/api/superadmin/organizations/${org.id}`, {
        method: 'PATCH',
        body: { status },
      }),
    onSuccess: invalidate,
  })

  return (
    <div className="fixed inset-0 z-30 flex justify-end">
      <button
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink-900/40"
      />
      <aside className="relative flex h-full w-full max-w-md flex-col overflow-y-auto bg-canvas-50 shadow-lift">
        <header className="sticky top-0 flex items-center justify-between gap-3 border-b border-canvas-200 bg-canvas-50/95 px-5 py-4 backdrop-blur">
          <div className="min-w-0">
            <p className="truncate text-lg font-extrabold text-ink-900">
              {org.name}
            </p>
            <p className="truncate text-[0.82rem] font-semibold text-ink-400">
              /{org.slug} · {org.timezone}
            </p>
          </div>
          <button
            aria-label="Close"
            onClick={onClose}
            className="flex size-9 shrink-0 items-center justify-center rounded-full text-ink-500 hover:bg-canvas-100"
          >
            <X className="size-5" strokeWidth={2.2} />
          </button>
        </header>

        <div className="flex flex-col gap-4 p-5">
          <Card className="p-4">
            <p className="mb-1 font-extrabold text-ink-800">Name</p>
            <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
              Shown on the sign-in screen and everywhere else in place of the
              wordmark.
            </p>
            <Field
              label="Name"
              placeholder="Heather"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="mb-3"
            />
            {nameError && (
              <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
                {nameError}
              </p>
            )}
            <Button
              full
              loading={saveName.isPending}
              disabled={!name.trim()}
              onClick={() => saveName.mutate()}
            >
              Save name
            </Button>
          </Card>

          <OrgLogoCard org={org} />

          <Card className="p-4">
            <p className="mb-1 font-extrabold text-ink-800">Colours</p>
            <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
              Primary fills buttons and links; accent marks the urgent ones.
              Status colours — here, absent, pending — are never themed, because
              they carry meaning.
            </p>
            <div className="mb-3 grid gap-3 sm:grid-cols-2">
              <ColourField
                label="Primary"
                fallback="#2F6FED"
                value={primary}
                onChange={setPrimary}
              />
              <ColourField
                label="Accent"
                fallback="#FF5A36"
                value={accent}
                onChange={setAccent}
              />
            </div>
            {error && (
              <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
                {error}
              </p>
            )}
            <Button full loading={saveBrand.isPending} onClick={() => saveBrand.mutate()}>
              Save colours
            </Button>
          </Card>

          <OutgoingMail org={org} />

          <Administrators org={org} />

          <Card className="p-4">
            <p className="mb-1 font-extrabold text-ink-800">Modules</p>
            <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
              Attendance and rosters are always on — they are the product.
            </p>
            <ul className="flex flex-col divide-y divide-canvas-200">
              {modules.map((m) => {
                const on = org.modules[m.key] ?? m.default
                return (
                  <li
                    key={m.key}
                    className="flex items-center justify-between gap-3 py-2.5"
                  >
                    <span className="text-[0.92rem] font-bold text-ink-700">
                      {m.label}
                    </span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={on}
                      aria-label={m.label}
                      onClick={() => toggleModule.mutate({ [m.key]: !on })}
                      className={`relative h-6 w-11 shrink-0 rounded-full transition-colors ${
                        on ? 'bg-leaf-500' : 'bg-canvas-200'
                      }`}
                    >
                      <span
                        className={`absolute top-0.5 size-5 rounded-full bg-white shadow-soft transition-all ${
                          on ? 'left-[1.375rem]' : 'left-0.5'
                        }`}
                      />
                    </button>
                  </li>
                )
              })}
            </ul>
          </Card>

          <Card className="p-4">
            <p className="mb-1 font-extrabold text-ink-800">Status</p>
            <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
              Suspending keeps the data but should stop the organization being
              used.
            </p>
            {org.status === 'active' ? (
              <Button
                variant="danger"
                full
                loading={setStatus.isPending}
                onClick={() => setStatus.mutate('suspended')}
              >
                Suspend organization
              </Button>
            ) : (
              <Button
                full
                loading={setStatus.isPending}
                onClick={() => setStatus.mutate('active')}
              >
                Reactivate organization
              </Button>
            )}
          </Card>

          <DangerZone
            org={org}
            onDeleted={() => {
              invalidate()
              onClose()
            }}
          />
        </div>
      </aside>
    </div>
  )
}

/* ── List ────────────────────────────────────────────────────────────── */

export function SuperadminOrganizations() {
  const qc = useQueryClient()
  const [open, setOpen] = useState<Organization | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [error, setError] = useState('')

  const { data: orgs, isPending } = useQuery({
    queryKey: ['superadmin', 'organizations'],
    queryFn: () => api<Organization[]>('/api/superadmin/organizations'),
  })

  const { data: modules } = useQuery({
    queryKey: ['superadmin', 'modules'],
    queryFn: () => api<ModuleDef[]>('/api/superadmin/modules'),
  })

  const create = useMutation({
    mutationFn: () =>
      api<Organization>('/api/superadmin/organizations', {
        method: 'POST',
        body: { name, slug },
      }),
    onSuccess: () => {
      setName('')
      setSlug('')
      setCreating(false)
      setError('')
      void qc.invalidateQueries({ queryKey: ['superadmin', 'organizations'] })
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not create it.'),
  })

  const columns: Column<Organization>[] = [
    {
      key: 'name',
      header: 'Organization',
      render: (o) => (
        <span className="flex items-center gap-2.5">
          <span
            className="size-8 shrink-0 rounded-xl"
            style={{ background: o.brand_primary ?? 'var(--color-canvas-200)' }}
          />
          <span>
            <span className="block font-bold text-ink-900">{o.name}</span>
            <span className="block text-[0.78rem] font-semibold text-ink-400">
              /{o.slug}
            </span>
          </span>
        </span>
      ),
    },
    { key: 'children', header: 'Children', align: 'right' },
    { key: 'parents', header: 'Parents', align: 'right', secondary: true },
    { key: 'counselors', header: 'Counselors', align: 'right', secondary: true },
    {
      key: 'modules',
      header: 'Modules on',
      align: 'right',
      secondary: true,
      value: (o) => Object.values(o.modules).filter(Boolean).length,
    },
    {
      key: 'status',
      header: 'Status',
      align: 'right',
      render: (o) =>
        o.status === 'active' ? (
          <Pill status="leaf">Active</Pill>
        ) : (
          <Pill status="berry">Suspended</Pill>
        ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-6xl">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Organizations
      </h1>

      {creating && (
        <Card className="mb-4 p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="Name"
              placeholder="Miami Beach JCC"
              value={name}
              onChange={(e) => {
                setName(e.target.value)
                // Suggest a slug, but leave it editable — it's the permanent
                // handle and can't be changed later.
                if (!slug || slug === suggestSlug(name))
                  setSlug(suggestSlug(e.target.value))
              }}
            />
            <Field
              label="Slug"
              hint="Permanent. Lowercase letters, numbers and hyphens."
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
              {error}
            </p>
          )}
          <div className="mt-4 flex gap-2">
            <Button
              disabled={!name || !slug}
              loading={create.isPending}
              onClick={() => create.mutate()}
            >
              Create
            </Button>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </div>
        </Card>
      )}

      {isPending ? (
        <Skeleton className="h-52" />
      ) : (
        <DataTable
          rows={orgs}
          columns={columns}
          searchPlaceholder="Search organizations…"
          emptyIcon={<Building2 className="size-7" strokeWidth={1.8} />}
          emptyTitle="No organizations yet"
          emptyBody="Create one to onboard a JCC."
          onRowClick={(o) => setOpen(o)}
          actions={
            <Button size="sm" onClick={() => setCreating((v) => !v)}>
              <Plus className="size-4" strokeWidth={2.6} />
              New organization
            </Button>
          }
        />
      )}

      {open && modules && (
        <OrgPanel
          // Re-read from the list so the panel reflects the latest save.
          org={orgs?.find((o) => o.id === open.id) ?? open}
          modules={modules}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

function suggestSlug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
}
