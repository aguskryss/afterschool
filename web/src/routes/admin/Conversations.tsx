import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Mail,
  MessagesSquare,
  Phone,
  Search,
  Send,
  TriangleAlert,
  X,
} from 'lucide-react'
import { api } from '@/lib/api'
import { Avatar, Button, Card, EmptyState, Pill, Skeleton } from '@/components/ui'
import { ResendInvite } from '@/components/people'
import { matchesName } from '@/lib/roster'
import { useConversationStream } from '@/lib/useConversationStream'

type Thread = {
  id: number
  parent_id: number
  parent_name: string
  parent_email: string
  last_message_at: string | null
  last_body: string | null
  admin_unread: number
}

type ThreadMessage = {
  id: number
  sender_role: 'parent' | 'admin'
  sender_name: string
  body: string
  created_at: string
}

/* A child as /api/admin/parents hands it over. `active` is the raw 0/1 the
   column holds, not a bool — same as AdminParents reads it. */
type ParentChild = {
  id: number
  name: string
  school: string
  grade_label: string | null
  active: number
}

type ParentRow = {
  id: number
  name: string
  email: string
  phone: string
  password_set: boolean
  children: ParentChild[]
}

/** A parent plus the thread they may or may not already have. */
type Family = ParentRow & { thread: Thread | null }

/* The right pane's own view of the family, which the list can't supply:
   grades, schools, portal state and the second contact's phone. */
type FamilyDetail = {
  parent: {
    id: number
    name: string
    email: string
    phone: string
    password_set: boolean
  }
  children: {
    id: number
    name: string
    grade_label: string | null
    school: string | null
    active: boolean
  }[]
  other_contacts: { name: string; phone: string | null; email: string | null }[]
  messages: ThreadMessage[]
}

const MAX_ROWS = 40

function when(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days === 0)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const kidNames = (f: Family) => f.children.map((c) => c.name).join(' · ')

const kidNamesWithGrade = (f: Family) =>
  f.children
    .map((c) => (c.grade_label ? `${c.name} (${c.grade_label})` : c.name))
    .join(' · ')

const schoolsOf = (f: Family) =>
  [...new Set(f.children.map((c) => c.school).filter(Boolean))].join(' · ')

/**
 * Does this family answer what was typed?
 *
 * The office thinks in children — "the mother of Ari" — so a child's name has
 * to find the family just as well as the parent's own. matchesName folds
 * accents and prefix-matches every term against any part of the name; its
 * substring fallback is what makes it work on an email or a phone number too.
 */
function matchesFamily(f: Family, query: string): boolean {
  return (
    matchesName(f.name, query) ||
    f.children.some((c) => matchesName(c.name, query)) ||
    (!!f.email && matchesName(f.email, query)) ||
    (!!f.phone && matchesName(f.phone, query))
  )
}

/* ── Search ──────────────────────────────────────────────────────────── */

function SearchBox({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="relative">
      <Search
        className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-400"
        strokeWidth={2.4}
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search by child or parent name"
        aria-label="Search families by child or parent name"
        // The browser's own clear button is suppressed: it lands a second
        // cross right beside this one, and only one of them is ours.
        className="h-11 w-full appearance-none rounded-full border-2 border-canvas-200 bg-white pr-11 pl-11 text-[0.9rem] font-medium text-ink-900 outline-none transition [&::-webkit-search-cancel-button]:appearance-none placeholder:font-normal placeholder:text-ink-400 focus:border-grape-500"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-canvas-100 hover:text-ink-700"
        >
          <X className="size-4" strokeWidth={2.6} />
        </button>
      )}
    </div>
  )
}

/* ── One family in the list ──────────────────────────────────────────── */

/**
 * The children are on the row for both shapes, and that is the point: a thread
 * knows only a parent_id, so a list of parent names alone leaves the office
 * guessing which family "Rachel Cohen" is.
 */
function FamilyRow({
  family,
  selected,
  onSelect,
}: {
  family: Family
  selected: boolean
  onSelect: () => void
}) {
  const t = family.thread
  const kids = t ? kidNames(family) : kidNamesWithGrade(family)
  return (
    <li>
      <button
        type="button"
        aria-current={selected}
        onClick={onSelect}
        className={`flex w-full items-start gap-3 px-4 py-3 text-left transition-colors ${
          selected ? 'bg-grape-50' : 'hover:bg-canvas-100'
        }`}
      >
        <Avatar name={family.name} id={family.id} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-bold text-ink-900">{family.name}</p>
          <p className="truncate text-[0.78rem] font-semibold text-ink-400">
            {kids || 'No children on the roster'}
          </p>
          <p className="truncate text-[0.82rem] font-medium text-ink-500">
            {t
              ? (t.last_body ?? 'No messages')
              : [schoolsOf(family), family.email].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {t ? (
            <>
              <span className="text-[0.72rem] font-semibold text-ink-400">
                {when(t.last_message_at)}
              </span>
              {t.admin_unread > 0 && (
                <span className="inline-flex min-w-5 justify-center rounded-full bg-grape-500 px-1.5 text-[0.7rem] font-extrabold text-white">
                  {t.admin_unread}
                </span>
              )}
            </>
          ) : (
            <span className="text-[0.72rem] font-extrabold text-grape-600">
              New
            </span>
          )}
          {!family.password_set && <Pill status="sun">No portal</Pill>}
        </div>
      </button>
    </li>
  )
}

function SectionLabel({ children }: { children: string }) {
  return (
    <p className="bg-canvas-50 px-4 py-1.5 text-[0.68rem] font-extrabold tracking-[0.12em] text-ink-400 uppercase">
      {children}
    </p>
  )
}

/* ── Who you are writing to ──────────────────────────────────────────── */

function FamilyHeader({ detail }: { detail: FamilyDetail }) {
  const { parent, children: kids, other_contacts: others } = detail
  return (
    <div className="mb-3 border-b border-canvas-200 pb-3">
      <div className="flex items-start gap-3">
        <Avatar name={parent.name} id={parent.id} size="lg" />
        <div className="min-w-0 flex-1">
          <p className="text-lg font-extrabold text-ink-900">{parent.name}</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[0.82rem] font-semibold text-ink-500">
            <a
              href={`mailto:${parent.email}`}
              className="inline-flex items-center gap-1 hover:text-ink-800"
            >
              <Mail className="size-3.5" strokeWidth={2.4} />
              {parent.email}
            </a>
            {parent.phone && (
              <a
                href={`tel:${parent.phone}`}
                className="inline-flex items-center gap-1 hover:text-ink-800"
              >
                <Phone className="size-3.5" strokeWidth={2.4} />
                {parent.phone}
              </a>
            )}
          </div>
        </div>
      </div>

      {kids.length > 0 && (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {kids.map((c) => (
            // Straight to the child's profile: half of what the office needs
            // mid-conversation — allergies, schedule, pickup — lives there.
            <Link
              key={c.id}
              to={`/children/${c.id}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-canvas-100 px-3 py-1 text-xs font-bold text-ink-700 transition-colors hover:bg-canvas-200"
            >
              {c.name}
              <span className="font-semibold text-ink-400">
                {[c.grade_label, c.school].filter(Boolean).join(' · ')}
              </span>
              {!c.active && <Pill status="neutral">Inactive</Pill>}
            </Link>
          ))}
        </div>
      )}

      {!parent.password_set && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-2xl bg-sun-50 px-3 py-2">
          <TriangleAlert className="size-4 shrink-0 text-sun-600" strokeWidth={2.4} />
          <p className="flex-1 text-[0.82rem] font-semibold text-sun-600">
            Hasn't set up their portal account yet — the message waits for them.
          </p>
          <ResendInvite
            endpoint={`/api/admin/parents/${parent.id}/resend-invite`}
            label="Resend invite"
          />
        </div>
      )}

      {others.length > 0 && (
        <p className="mt-2 text-[0.8rem] font-semibold text-ink-400">
          Also on file:{' '}
          {others
            .map((o) => [o.name, o.phone].filter(Boolean).join(' · '))
            .join(' — ')}{' '}
          (no portal login — call instead)
        </p>
      )}
    </div>
  )
}

function Conversation({ parentId }: { parentId: number }) {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  const { data, isPending, isSuccess } = useQuery({
    queryKey: ['admin', 'conversations', parentId],
    queryFn: () => api<FamilyDetail>(`/api/admin/conversations/${parentId}`),
  })

  const send = useMutation({
    mutationFn: () =>
      api(`/api/admin/conversations/${parentId}`, {
        method: 'POST',
        body: { body },
      }),
    onSuccess: () => {
      setBody('')
      void qc.invalidateQueries({ queryKey: ['admin', 'conversations'] })
    },
  })

  const messages = data?.messages ?? []

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length])

  // The GET is what clears admin_unread server-side, so the list pill and the
  // nav badge are stale the moment it returns. Both keys are invalidated
  // exactly — a prefix would take this very query with it and loop.
  useEffect(() => {
    if (!isSuccess) return
    void qc.invalidateQueries({ queryKey: ['admin', 'conversations'], exact: true })
    void qc.invalidateQueries({ queryKey: ['admin', 'conversations', 'unread'] })
  }, [isSuccess, parentId, qc])

  if (isPending) return <Skeleton className="h-64" />
  if (!data)
    return (
      <EmptyState
        title="Could not load this conversation"
        body="Refresh the page and try again."
      />
    )

  return (
    <div className="flex h-full flex-col">
      <FamilyHeader detail={data} />

      <div className="mb-3 flex flex-1 flex-col gap-2 overflow-y-auto">
        {messages.length === 0 ? (
          <EmptyState
            icon={<MessagesSquare className="size-7" strokeWidth={1.8} />}
            title="No messages yet"
            body="Whatever you write will be the first thing this family hears from the office here."
          />
        ) : (
          messages.map((m) => {
            const mine = m.sender_role === 'admin'
            return (
              <div
                key={m.id}
                className={`max-w-[80%] rounded-3xl px-4 py-2.5 ${
                  mine
                    ? 'self-end rounded-br-lg bg-grape-500 text-white'
                    : 'self-start rounded-bl-lg bg-canvas-100 text-ink-900'
                }`}
              >
                <p className="text-[0.92rem] font-medium whitespace-pre-wrap">
                  {m.body}
                </p>
                <p
                  className={`mt-0.5 text-[0.7rem] font-semibold ${
                    mine ? 'text-white/70' : 'text-ink-400'
                  }`}
                >
                  {m.sender_name} · {when(m.created_at)}
                </p>
              </div>
            )
          })
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (body.trim()) send.mutate()
        }}
        className="flex items-end gap-2"
      >
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={2}
          placeholder={
            messages.length ? 'Reply…' : `Write to ${data.parent.name}…`
          }
          aria-label={messages.length ? 'Reply' : 'Write the first message'}
          className="min-w-0 flex-1 resize-none rounded-2xl border border-canvas-200 bg-white px-4 py-2.5 text-[0.92rem] font-medium text-ink-900 outline-none focus:border-grape-500"
        />
        <Button type="submit" loading={send.isPending} disabled={!body.trim()}>
          <Send className="size-4" strokeWidth={2.4} />
          Send
        </Button>
      </form>
    </div>
  )
}

/**
 * Conversations with families.
 *
 * List on the left, thread on the right — the shape every mail client uses,
 * and the reason this is its own screen rather than a tab inside Messages:
 * that one composes a broadcast to everyone, this one answers one family.
 *
 * The search box sits above the list and is always mounted, including when
 * there is not a single thread yet: the office needs to be able to open a
 * conversation, not only answer one, and /api/admin/conversations can only
 * ever return families who wrote first.
 */
export function AdminConversations() {
  const [selected, setSelected] = useState<number | null>(null)
  const [query, setQuery] = useState('')

  const qc = useQueryClient()

  const { data: threads, isPending } = useQuery({
    queryKey: ['admin', 'conversations'],
    queryFn: () => api<Thread[]>('/api/admin/conversations'),
    // Kept alongside the live stream, not replaced by it. SSE is the thing
    // that makes a reply appear now; this is the net for the case where the
    // connection dropped and EventSource has not reconnected yet, which is
    // silent from in here. A minute of staleness is the worst case instead of
    // the normal one.
    refetchInterval: 60_000,
  })

  // One invalidation covers the list, whichever thread is open, and the unread
  // badge: react-query matches by key prefix, and all three start with
  // ['admin', 'conversations'].
  const refetch = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['admin', 'conversations'] })
  }, [qc])
  useConversationStream({ role: 'admin', onMessage: refetch, onResync: refetch })

  // Core route, no module of its own, and the same key AdminParents uses — so
  // walking over from People costs nothing.
  const { data: parents, isPending: parentsPending } = useQuery({
    queryKey: ['admin', 'parents'],
    queryFn: () => api<ParentRow[]>('/api/admin/parents'),
  })

  const parentById = useMemo(
    () => new Map((parents ?? []).map((p) => [p.id, p])),
    [parents],
  )

  // Open conversations are built from the thread list, not from the parent
  // roster, and stay in the order the server sent them (last message first).
  // If /api/admin/parents ever fails, the screen degrades to names only —
  // rather than showing an office with no conversations at all.
  const open = useMemo<Family[]>(
    () =>
      (threads ?? []).map((t) => {
        const p = parentById.get(t.parent_id)
        return {
          id: t.parent_id,
          name: t.parent_name,
          email: t.parent_email,
          phone: p?.phone ?? '',
          // Without the roster row, say nothing rather than cry wolf.
          password_set: p?.password_set ?? true,
          children: p?.children ?? [],
          thread: t,
        }
      }),
    [threads, parentById],
  )

  const searchable = useMemo<Family[]>(() => {
    const withThread = new Set(open.map((f) => f.id))
    return [
      ...open,
      ...(parents ?? [])
        .filter((p) => !withThread.has(p.id))
        .map((p) => ({ ...p, thread: null })),
    ]
  }, [open, parents])

  const q = query.trim()
  const hits = useMemo(
    () => (q ? searchable.filter((f) => matchesFamily(f, q)) : []),
    [searchable, q],
  )
  const hitThreads = hits.filter((f) => f.thread)
  const hitNew = hits.filter((f) => !f.thread)

  // Every parent is already in memory, so the search is instant; the cap is
  // about the eye, not the CPU — a roster's worth of rows is not a shortlist.
  // What the cap drops is counted and said out loud, in both sections: a list
  // that silently stops at forty reads as "that is everyone".
  const shownThreads = hitThreads.slice(0, MAX_ROWS)
  const shownNew = hitNew.slice(0, MAX_ROWS)
  const hidden =
    hitThreads.length - shownThreads.length + (hitNew.length - shownNew.length)

  const row = (f: Family) => (
    <FamilyRow
      key={f.id}
      family={f}
      selected={selected === f.id}
      onSelect={() => setSelected(f.id)}
    />
  )

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Conversations
      </h1>

      <div className="grid gap-4 lg:grid-cols-[23rem_1fr]">
        <Card className="overflow-hidden">
          <div className="border-b border-canvas-200 p-3">
            <SearchBox value={query} onChange={setQuery} />
          </div>

          {isPending || parentsPending ? (
            <div className="p-4">
              <Skeleton className="h-40" />
            </div>
          ) : q ? (
            hits.length === 0 ? (
              <EmptyState
                title="No families match"
                body="Try a first name, a last name, or an email."
              />
            ) : (
              <div className="max-h-[34rem] overflow-y-auto">
                {shownThreads.length > 0 && (
                  <>
                    <SectionLabel>Conversations</SectionLabel>
                    <ul className="divide-y divide-canvas-200">
                      {shownThreads.map(row)}
                    </ul>
                  </>
                )}
                {shownNew.length > 0 && (
                  <>
                    <SectionLabel>Start a new conversation</SectionLabel>
                    <ul className="divide-y divide-canvas-200">
                      {shownNew.map(row)}
                    </ul>
                  </>
                )}
                {hidden > 0 && (
                  <p className="px-4 py-3 text-[0.8rem] font-semibold text-ink-400">
                    Keep typing — {hidden} more{' '}
                    {hidden === 1 ? 'family matches' : 'families match'}, not shown.
                  </p>
                )}
              </div>
            )
          ) : open.length === 0 ? (
            <EmptyState
              icon={<MessagesSquare className="size-7" strokeWidth={1.8} />}
              title="No conversations yet"
              body="Search a child or a parent above to start one."
            />
          ) : (
            <div className="max-h-[34rem] overflow-y-auto">
              <ul className="divide-y divide-canvas-200">{open.map(row)}</ul>
            </div>
          )}
        </Card>

        <Card className="min-h-[24rem] p-4">
          {selected === null ? (
            <EmptyState
              icon={<MessagesSquare className="size-7" strokeWidth={1.8} />}
              title="Pick a conversation"
              body="Choose a family on the left, or search for one to write to first."
            />
          ) : (
            <Conversation parentId={selected} />
          )}
        </Card>
      </div>
    </div>
  )
}
