import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ClipboardList, Shield, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { DataTable, type Column } from '@/components/DataTable'
import { ExportButton } from '@/components/ExportButton'
import { Avatar, Button, Pill } from '@/components/ui'
import { CounselorSchools } from '@/components/CounselorSchools'
import {
  AddButton,
  AddChild,
  AddPersonForm,
  BulkInviteCard,
  DeletePerson,
  InviteStatus,
  ResendInvite,
  SetupLink,
} from '@/components/people'

type School = { id: number; name: string }

function useSchools() {
  return useQuery({
    queryKey: ['admin', 'schools'],
    queryFn: () => api<School[]>('/api/admin/schools'),
  })
}

/* ── Parents ─────────────────────────────────────────────────────────── */

type ParentChild = {
  id: number
  name: string
  school: string
  service_type: string
  active: number
}

type Parent = {
  id: number
  name: string
  email: string
  is_new: boolean
  password_set_at: string | null
  last_invite_at: string | null
  children: ParentChild[]
}

export function AdminParents() {
  const [adding, setAdding] = useState(false)
  // Needed by AddChild below: a child cannot be enrolled without a school.
  // Same query key the counselors table uses, so it costs nothing here.
  const { data: schools } = useSchools()
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'parents'],
    queryFn: () => api<Parent[]>('/api/admin/parents'),
  })

  const columns: Column<Parent>[] = [
    {
      key: 'name',
      header: 'Parent',
      render: (p) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={p.name} id={p.id} size="sm" />
          <span className="font-bold text-ink-900">{p.name}</span>
        </span>
      ),
    },
    { key: 'email', header: 'Email' },
    {
      key: 'children',
      header: 'Children',
      value: (p) => p.children.map((c) => c.name).join(', '),
      render: (p) =>
        p.children.length === 0 ? (
          <span className="text-ink-400">None</span>
        ) : (
          <span className="flex flex-wrap gap-1.5">
            {p.children.map((c) => (
              <span
                key={c.id}
                className="rounded-full bg-canvas-100 px-2.5 py-1 text-xs font-bold text-ink-600"
              >
                {c.name}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'status',
      header: 'Access',
      value: (p) =>
        p.password_set_at ? 'Active' : p.last_invite_at ? 'Invited' : 'Not invited',
      render: (p) => (
        <InviteStatus
          active={Boolean(p.password_set_at)}
          invitedAt={p.last_invite_at}
        />
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      value: () => '',
      render: (p) => (
        <span className="flex items-center justify-end gap-2">
          {/* Surfaced only for a childless family, which is the case that is
              actually broken: they cannot be reached by any broadcast, because
              an audience is resolved through children even when it is
              "everyone". Every other family already has children and edits
              them from the Children screen. */}
          {p.children.length === 0 && (
            <AddChild
              parentId={p.id}
              parentName={p.name}
              schools={schools ?? []}
            />
          )}
          {!p.password_set_at && (
            <>
              {/* Same pairing as the counselors table. The link matters more
                  here than anywhere: parent invitations are additionally
                  gated by PARENT_INVITES_ENABLED, so "Invite" can be refused
                  by the server while this still works. */}
              <SetupLink endpoint={`/api/admin/parents/${p.id}/setup-link`} />
              <ResendInvite
                endpoint={`/api/admin/parents/${p.id}/resend-invite`}
                label={p.last_invite_at ? 'Resend' : 'Invite'}
              />
            </>
          )}
          <DeletePerson
            endpoint={`/api/admin/parents/${p.id}`}
            what={p.name.split(' ')[0]}
            invalidate={['admin', 'parents']}
          />
        </span>
      ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-6xl">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Parents
      </h1>

      <BulkInviteCard />

      {adding && (
        <AddPersonForm
          title="Add a parent"
          endpoint="/api/admin/parents"
          invalidate={['admin', 'parents']}
          // Creating a parent deliberately sends nothing; the form hands back
          // their setup link instead. Saying "send invitation" here was the
          // reason an admin would add a parent and then wait for an email.
          submitLabel="Add parent"
          onDone={() => setAdding(false)}
        />
      )}

      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search parents, emails or children…"
        emptyIcon={<Users className="size-7" strokeWidth={1.8} />}
        emptyTitle="No parents yet"
        emptyBody="Add one here, or import the whole program from Upload roster."
        actions={
          <div className="flex items-center gap-2">
            <ExportButton
              path="/api/admin/export/roster"
              filename="roster.xlsx"
              label="Export roster"
            />
            <AddButton open={adding} onToggle={() => setAdding((v) => !v)}>
              {adding ? 'Cancel' : 'Add parent'}
            </AddButton>
          </div>
        }
      />
    </div>
  )
}

/* ── Counselors ──────────────────────────────────────────────────────── */

type CounselorSchool = {
  school_id: number
  school: string
  permanent: boolean
  in_effect: boolean
}

type Counselor = {
  id: number
  name: string
  email: string
  schools: CounselorSchool[]
  /** No assignments at all, which means every school — not none. */
  covers_all_schools: boolean
  password_set_at?: string | null
  last_invite_at?: string | null
}

export function AdminCounselors() {
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Counselor | null>(null)
  const { data: schools } = useSchools()
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'counselors'],
    queryFn: () => api<Counselor[]>('/api/admin/counselors'),
  })

  const columns: Column<Counselor>[] = [
    {
      key: 'name',
      header: 'Counselor',
      render: (c) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={c.name} id={c.id} size="sm" />
          <span className="font-bold text-ink-900">{c.name}</span>
        </span>
      ),
    },
    { key: 'email', header: 'Email' },
    {
      key: 'schools',
      header: 'Schools',
      value: (c) => c.schools.map((s) => s.school).join(', '),
      render: (c) =>
        c.covers_all_schools ? (
          // Not "no schools" — a counselor with no assignment covers every
          // school, so the roster works on day one at a JCC that hasn't
          // divided its staff up. Saying "Unassigned" read as the opposite.
          <Pill status="sun">Every school</Pill>
        ) : (
          <span className="flex flex-wrap gap-1.5">
            {c.schools.map((s) => (
              <span
                key={s.school_id}
                title={s.permanent ? 'Permanent' : 'Temporary cover'}
                className={`rounded-full px-2.5 py-1 text-xs font-bold ${
                  s.permanent
                    ? 'bg-canvas-100 text-ink-600'
                    : s.in_effect
                      ? 'bg-leaf-50 text-leaf-600'
                      : 'bg-canvas-100 text-ink-400 line-through'
                }`}
              >
                {s.school}
              </span>
            ))}
          </span>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      value: () => '',
      render: (c) => (
        <span className="flex items-center justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setEditing(editing?.id === c.id ? null : c)}
          >
            Schools
          </Button>
          {!c.password_set_at && (
            <>
              {/* Sits next to the email invitation rather than replacing it:
                  the link is how a JCC onboards staff before its mail
                  provider is configured, which is most of them on day one. */}
              <SetupLink
                endpoint={`/api/admin/counselors/${c.id}/setup-link`}
              />
              <ResendInvite
                endpoint={`/api/admin/counselors/${c.id}/resend-invite`}
                label={c.last_invite_at ? 'Resend' : 'Invite'}
              />
            </>
          )}
          <DeletePerson
            endpoint={`/api/admin/counselors/${c.id}`}
            what={c.name.split(' ')[0]}
            invalidate={['admin', 'counselors']}
          />
        </span>
      ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-6xl">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Counselors
      </h1>

      {adding && (
        <AddPersonForm
          title="Add a counselor"
          endpoint="/api/admin/counselors"
          invalidate={['admin', 'counselors']}
          schools={schools ?? []}
          onDone={() => setAdding(false)}
        />
      )}

      {editing && (
        <CounselorSchools
          counselorId={editing.id}
          counselorName={editing.name}
          onClose={() => setEditing(null)}
        />
      )}

      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search counselors or schools…"
        emptyIcon={<ClipboardList className="size-7" strokeWidth={1.8} />}
        emptyTitle="No counselors yet"
        actions={
          <AddButton open={adding} onToggle={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add counselor'}
          </AddButton>
        }
      />
    </div>
  )
}

/* ── Admins ──────────────────────────────────────────────────────────── */

type Admin = {
  id: number
  name: string
  email: string
  password_set: boolean
  is_self: boolean
  last_invite_at: string | null
  created_at: string
}

export function AdminAdmins() {
  const [adding, setAdding] = useState(false)
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'admins'],
    queryFn: () => api<Admin[]>('/api/admin/admins'),
  })

  const columns: Column<Admin>[] = [
    {
      key: 'name',
      header: 'Administrator',
      render: (a) => (
        <span className="flex items-center gap-2.5">
          <Avatar name={a.name} id={a.id} size="sm" />
          <span className="font-bold text-ink-900">{a.name}</span>
          {a.is_self && <Pill status="neutral">You</Pill>}
        </span>
      ),
    },
    { key: 'email', header: 'Email' },
    {
      key: 'password_set',
      header: 'Access',
      value: (a) => (a.password_set ? 'Active' : 'Pending'),
      render: (a) => (
        <InviteStatus active={a.password_set} invitedAt={a.last_invite_at} />
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      value: () => '',
      render: (a) =>
        // Never offer to delete or re-invite yourself: locking the last
        // administrator out of their own program isn't recoverable from here.
        a.is_self ? null : (
          <span className="flex items-center justify-end gap-2">
            {!a.password_set && (
              <>
                <SetupLink endpoint={`/api/admin/admins/${a.id}/setup-link`} />
                <ResendInvite
                  endpoint={`/api/admin/admins/${a.id}/resend-invite`}
                  label={a.last_invite_at ? 'Resend' : 'Invite'}
                />
              </>
            )}
            <DeletePerson
              endpoint={`/api/admin/admins/${a.id}`}
              what={a.name.split(' ')[0]}
              invalidate={['admin', 'admins']}
            />
          </span>
        ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-6xl">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Admins
      </h1>

      {adding && (
        <AddPersonForm
          title="Add an administrator"
          endpoint="/api/admin/admins"
          invalidate={['admin', 'admins']}
          onDone={() => setAdding(false)}
        />
      )}

      <DataTable
        rows={data}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search admins…"
        emptyIcon={<Shield className="size-7" strokeWidth={1.8} />}
        emptyTitle="No administrators"
        actions={
          <AddButton open={adding} onToggle={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add admin'}
          </AddButton>
        }
      />
    </div>
  )
}
