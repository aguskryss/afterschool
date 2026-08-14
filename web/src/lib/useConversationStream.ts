import { useEffect, useRef } from 'react'
import { readSession } from './auth'

/**
 * Live parent↔office messages over SSE.
 *
 * Before this, a reply only appeared if you reloaded the page — which in a
 * conversation is the difference between a chat and a form you keep
 * resubmitting.
 *
 * TWO ENDPOINTS, ONE EVENT, AND THE REASON IS THREADS.
 * Every open SSE connection holds a gunicorn thread for its whole life and
 * there are 64 of them (see CLAUDE.md §3). Parents are the many, so they reuse
 * `/api/parent/stream`, which already existed and only needed one more event
 * type. Admins are a handful per JCC and get their own feed. Opening a second
 * connection per parent would have been the expensive half of this feature.
 *
 * Mounted by the screen, not by the app: the connection lives exactly as long
 * as someone is looking at a conversation. An always-on stream would hold a
 * thread for every parent who left the tab open on some other page.
 *
 * `onMessage` is called with the new message; `onResync` when the server could
 * not fit the payload into a NOTIFY (8 KB cap — a long message) and the client
 * has to refetch instead. Handling only the first would make an unusually long
 * message the one that silently fails to arrive.
 */

export type ConversationMessage = {
  id: number
  sender_role: 'parent' | 'admin'
  sender_name: string
  body: string
  created_at: string
}

type Event = {
  parent_id: number
  message: ConversationMessage
}

export function useConversationStream({
  role,
  onMessage,
  onResync,
  enabled = true,
}: {
  role: 'parent' | 'admin'
  onMessage: (parentId: number, message: ConversationMessage) => void
  onResync: () => void
  enabled?: boolean
}) {
  // Held in refs so a caller passing inline closures — which is every caller —
  // doesn't tear the connection down and rebuild it on every render.
  const onMessageRef = useRef(onMessage)
  const onResyncRef = useRef(onResync)
  onMessageRef.current = onMessage
  onResyncRef.current = onResync

  useEffect(() => {
    if (!enabled) return
    const session = readSession()
    if (!session) return

    const path =
      role === 'admin' ? '/api/admin/conversations/stream' : '/api/parent/stream'
    const source = new EventSource(
      `${path}?token=${encodeURIComponent(session.token)}`,
    )

    source.addEventListener('conversation-message', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as Event
        if (data?.message?.id) onMessageRef.current(data.parent_id, data.message)
      } catch {
        // A malformed frame is not worth tearing the stream down for; the
        // next one will be fine, and a refresh still shows the thread.
      }
    })

    source.addEventListener('resync', () => onResyncRef.current())

    return () => source.close()
  }, [role, enabled])
}
