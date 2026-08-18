import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { MessagesSquare, Send } from 'lucide-react'
import { api } from '@/lib/api'
import { Button, Card, EmptyState, Skeleton } from '@/components/ui'

type ThreadMessage = {
  id: number
  sender_role: 'counselor' | 'admin'
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

/**
 * A counselor's one thread with the office — never with a parent, and never
 * with another counselor. The admin side of this same thread lives in
 * AdminConversations under its Staff tab.
 *
 * No live stream here: unlike the family inbox (parents, the many) and the
 * admin's own inbox (a handful of people, only while the screen is open),
 * every counselor in the building would be a connection each, and each one
 * holds a gunicorn thread for its whole life (CLAUDE.md §3, 64 threads
 * total). A 20s poll is the cheap way to make a reply show up without a
 * reload, and "the office replied a few seconds later" is not a workflow
 * anyone is timing.
 */
export function CounselorOffice() {
  const qc = useQueryClient()
  const [body, setBody] = useState('')
  const endRef = useRef<HTMLDivElement>(null)

  const { data, isPending } = useQuery({
    queryKey: ['counselor', 'conversation'],
    queryFn: () => api<{ messages: ThreadMessage[] }>('/api/counselor/conversation'),
    refetchInterval: 20_000,
  })

  const send = useMutation({
    mutationFn: () =>
      api('/api/counselor/conversation', { method: 'POST', body: { body } }),
    onSuccess: () => {
      setBody('')
      void qc.invalidateQueries({ queryKey: ['counselor', 'conversation'] })
    },
  })

  const messages = data?.messages ?? []

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' })
  }, [messages.length])

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <h1 className="mb-4 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Message the office
      </h1>

      {isPending ? (
        <Skeleton className="mb-3 h-40" />
      ) : messages.length === 0 ? (
        <Card className="mb-3">
          <EmptyState
            icon={<MessagesSquare className="size-7" strokeWidth={1.8} />}
            title="No messages yet"
            body="Write to the office about a schedule question, a room, or anything else that comes up."
          />
        </Card>
      ) : (
        <div className="mb-3 flex flex-col gap-2">
          {messages.map((m) => {
            const mine = m.sender_role === 'counselor'
            return (
              <div
                key={m.id}
                className={`max-w-[85%] rounded-3xl px-4 py-2.5 ${
                  mine
                    ? 'self-end rounded-br-lg bg-sky-500 text-white'
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
          className="min-w-0 flex-1 resize-none rounded-2xl border border-canvas-200 bg-white px-4 py-2.5 text-[0.92rem] font-medium text-ink-900 outline-none focus:border-sky-500"
        />
        <Button type="submit" loading={send.isPending} disabled={!body.trim()}>
          <Send className="size-4" strokeWidth={2.4} />
          Send
        </Button>
      </form>
    </div>
  )
}
