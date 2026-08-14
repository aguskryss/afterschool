import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Inbox as InboxIcon, MessagesSquare, Send, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { hasModule } from '@/lib/auth'
import { useConversationStream } from '@/lib/useConversationStream'
import { Button, Card, EmptyState, Skeleton } from '@/components/ui'

type Message = {
  id: number
  subject: string
  body: string
  sender_name: string | null
  sender_role: string | null
  sent_at: string
  read_at: string | null
}

type ThreadMessage = {
  id: number
  sender_role: 'parent' | 'admin'
  sender_name: string
  body: string
  created_at: string
}

function when(iso: string): string {
  const d = new Date(iso)
  const days = Math.floor((Date.now() - d.getTime()) / 86_400_000)
  if (days === 0)
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days} days ago`
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/* ── Announcements: the one-way broadcast from the office ──────────────── */

function Announcements() {
  const qc = useQueryClient()
  const [open, setOpen] = useState<number | null>(null)

  const { data: messages, isPending } = useQuery({
    queryKey: ['parent', 'messages'],
    queryFn: () => api<Message[]>('/api/parent/messages'),
  })

  const markAllRead = useMutation({
    mutationFn: () =>
      api('/api/parent/messages/mark-all-read', { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['parent'] }),
  })

  const remove = useMutation({
    mutationFn: (id: number) =>
      api(`/api/parent/messages/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['parent', 'messages'] }),
  })

  // Opening the inbox is the read receipt — there's no per-message read
  // endpoint, and leaving a badge up after someone has plainly looked at the
  // list is just noise.
  const unread = messages?.some((m) => !m.read_at)
  useEffect(() => {
    if (unread && !markAllRead.isPending && !markAllRead.isSuccess) {
      markAllRead.mutate()
    }
  }, [unread, markAllRead])

  if (isPending) return <Skeleton className="h-40" />
  if (!messages?.length) {
    return (
      <Card>
        <EmptyState
          icon={<InboxIcon className="size-7" strokeWidth={1.8} />}
          title="No messages"
          body="Announcements from the program team will land here."
        />
      </Card>
    )
  }

  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-canvas-200">
        {messages.map((m) => {
          const expanded = open === m.id
          return (
            <li key={m.id}>
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : m.id)}
                  className="min-w-0 flex-1 px-4 py-3.5 text-left transition-colors hover:bg-canvas-100"
                >
                  <div className="flex items-baseline justify-between gap-3">
                    <p
                      className={`truncate ${m.read_at ? 'font-bold' : 'font-extrabold'} text-ink-900`}
                    >
                      {!m.read_at && (
                        <span
                          aria-label="Unread"
                          className="mr-2 inline-block size-2 shrink-0 rounded-full bg-sky-500 align-middle"
                        />
                      )}
                      {m.subject}
                    </p>
                    <span className="shrink-0 text-[0.75rem] font-semibold text-ink-400">
                      {when(m.sent_at)}
                    </span>
                  </div>
                  <p
                    className={`mt-0.5 text-[0.85rem] font-medium text-ink-500 ${expanded ? '' : 'truncate'}`}
                  >
                    {m.body}
                  </p>
                  {expanded && m.sender_name && (
                    <p className="mt-2 text-[0.78rem] font-semibold text-ink-400">
                      From {m.sender_name}
                    </p>
                  )}
                </button>
                <button
                  type="button"
                  aria-label={`Delete ${m.subject}`}
                  onClick={() => remove.mutate(m.id)}
                  className="mt-3 mr-2 flex size-9 shrink-0 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-berry-50 hover:text-berry-500"
                >
                  <Trash2 className="size-4" strokeWidth={2.1} />
                </button>
              </div>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}

/* ── Office: the two-way thread ────────────────────────────────────────── */

function Office() {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  const { data, isPending } = useQuery({
    queryKey: ['parent', 'conversation'],
    queryFn: () =>
      api<{ messages: ThreadMessage[] }>('/api/parent/conversation'),
  })

  const send = useMutation({
    mutationFn: () =>
      api('/api/parent/conversation', { method: 'POST', body: { body } }),
    onSuccess: () => {
      setBody('')
      void qc.invalidateQueries({ queryKey: ['parent', 'conversation'] })
    },
  })

  // A reply from the office lands without a reload. Refetching rather than
  // splicing the message into the cache: the thread is small, and the server's
  // copy is the one that has the read state and the ordering right.
  //
  // The stream is opened here rather than app-wide so it lives exactly as long
  // as this screen — see useConversationStream on why that matters at 64
  // threads.
  const refetch = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['parent', 'conversation'] })
  }, [qc])
  useConversationStream({ role: 'parent', onMessage: refetch, onResync: refetch })

  const messages = data?.messages ?? []

  // Newest at the bottom, like every other messaging surface people use.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length])

  return (
    <>
      {isPending ? (
        <Skeleton className="mb-3 h-40" />
      ) : messages.length === 0 ? (
        <Card className="mb-3">
          <EmptyState
            icon={<MessagesSquare className="size-7" strokeWidth={1.8} />}
            title="No messages yet"
            body="Ask the office anything — schedules, pickup changes, billing."
          />
        </Card>
      ) : (
        <div className="mb-3 flex flex-col gap-2">
          {messages.map((m) => {
            const mine = m.sender_role === 'parent'
            return (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-3xl px-4 py-2.5 ${
                  mine
                    ? 'self-end rounded-br-lg bg-grape-500 text-white'
                    : 'self-start rounded-bl-lg bg-canvas-100 text-ink-900'
                }`}
              >
                {!mine && (
                  <p className="mb-0.5 text-[0.74rem] font-extrabold text-ink-500">
                    {m.sender_name}
                  </p>
                )}
                <p className="text-[0.92rem] font-medium whitespace-pre-wrap">
                  {m.body}
                </p>
                <p
                  className={`mt-0.5 text-[0.7rem] font-semibold ${
                    mine ? 'text-white/70' : 'text-ink-400'
                  }`}
                >
                  {when(m.created_at)}
                </p>
              </div>
            )
          })}
          <div ref={endRef} />
        </div>
      )}

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
          placeholder="Message the office…"
          aria-label="Message the office"
          className="min-w-0 flex-1 resize-none rounded-2xl border border-canvas-200 bg-white px-4 py-2.5 text-[0.92rem] font-medium text-ink-900 outline-none focus:border-grape-500"
        />
        <Button type="submit" loading={send.isPending} disabled={!body.trim()}>
          <Send className="size-4" strokeWidth={2.4} />
          Send
        </Button>
      </form>
    </>
  )
}

export function ParentInbox() {
  const announcements = hasModule('messages')
  const office = hasModule('parent_messaging')
  const [tab, setTab] = useState<'announcements' | 'office'>(
    announcements ? 'announcements' : 'office',
  )

  // With one module on there is nothing to switch between, so the tab bar
  // would be a control that does nothing.
  const bothOn = announcements && office

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <h1 className="mb-4 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Inbox
      </h1>

      {bothOn && (
        <div
          role="tablist"
          aria-label="Inbox sections"
          className="mb-4 flex rounded-full bg-canvas-100 p-1"
        >
          {(
            [
              ['announcements', 'Announcements'],
              ['office', 'Office'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={`flex-1 rounded-full px-3.5 py-1.5 text-[0.85rem] font-bold transition ${
                tab === key ? 'bg-white text-ink-900 shadow-soft' : 'text-ink-500'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {(bothOn ? tab === 'announcements' : announcements) && <Announcements />}
      {(bothOn ? tab === 'office' : office) && <Office />}
    </div>
  )
}
