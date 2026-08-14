import { useEffect, useState } from 'react'
import { readSession } from './auth'

export type Pickup = {
  id: number
  child_id: number
  parent_name: string
  child_name: string
  created_at: string
  claimed_by: number | null
  claimed_by_name: string | null
  claimed_at: string | null
}

type Status = 'connecting' | 'live' | 'offline'

/**
 * Live pickup queue over SSE.
 *
 * EventSource can't send an Authorization header, so the server takes the JWT
 * as a query parameter and validates it by hand — that's why the token is in
 * the URL here rather than a header.
 *
 * The server emits *named* events (`event: snapshot`, `created`, `claimed`…),
 * so there is nothing on the default `message` channel and `onmessage` never
 * fires. Each type is subscribed to explicitly below.
 *
 * The feed only ever carries unclaimed pickups: once anyone claims one it
 * leaves the queue for every counselor, which is what makes visibility the
 * accountability signal.
 */
export function usePickupStream() {
  const [pickups, setPickups] = useState<Pickup[]>([])
  const [status, setStatus] = useState<Status>('connecting')

  useEffect(() => {
    const session = readSession()
    if (!session) return

    const source = new EventSource(
      `/api/pickups/stream?token=${encodeURIComponent(session.token)}`,
    )

    const parse = (event: MessageEvent): unknown => {
      try {
        return JSON.parse(event.data)
      } catch {
        return null
      }
    }

    const byOldestFirst = (list: Pickup[]) =>
      [...list].sort((a, b) => a.created_at.localeCompare(b.created_at))

    source.addEventListener('snapshot', (e) => {
      const data = parse(e as MessageEvent)
      if (Array.isArray(data)) setPickups(byOldestFirst(data as Pickup[]))
      setStatus('live')
    })

    // 'created' and 'unclaimed' both put a pickup back in the queue; dedupe by
    // id so a reconnect replaying an event can't double it up.
    const upsert = (e: Event) => {
      const p = parse(e as MessageEvent) as Pickup | null
      if (!p?.id) return
      setPickups((prev) =>
        byOldestFirst([...prev.filter((x) => x.id !== p.id), p]),
      )
    }
    source.addEventListener('created', upsert)
    source.addEventListener('unclaimed', upsert)

    source.addEventListener('claimed', (e) => {
      const p = parse(e as MessageEvent) as Pickup | null
      if (!p?.id) return
      setPickups((prev) => prev.filter((x) => x.id !== p.id))
    })

    source.addEventListener('heartbeat', () => setStatus('live'))
    source.onopen = () => setStatus('live')
    // EventSource reconnects on its own; surface the gap rather than hiding it,
    // because a counselor trusting a stale queue is worse than one who knows.
    source.onerror = () => setStatus('offline')

    return () => source.close()
  }, [])

  return { pickups, status }
}
