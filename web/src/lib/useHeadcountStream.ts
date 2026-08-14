import { useEffect, useState } from 'react'
import { readSession } from './auth'

export type SchoolHeadcount = {
  school_id: number
  school: string
  present: number
  released: number
  /** Enrolled on this weekday and not accounted for as absent. */
  expected: number
  /** Enrolled today but reported absent and never checked in. */
  absent: number
  /**
   * Not in today: enrolled on other weekdays, or on none yet. With `expected`
   * and `absent` this partitions every active child at the school.
   */
  unscheduled: number
}

type Status = 'connecting' | 'live' | 'offline'

/**
 * Live headcount over SSE, for the admin dashboard.
 *
 * Same shape as usePickupStream: EventSource can't send an Authorization
 * header, so the token goes in the query string and the server validates it by
 * hand. The server emits a named `headcount` event, so nothing arrives on the
 * default channel and `onmessage` never fires.
 *
 * Every payload is a full snapshot rather than a delta. Counts are small and a
 * reconnect that replays or misses an event would otherwise leave the tile
 * quietly wrong, which is worse than a slightly chattier feed.
 */
export function useHeadcountStream(enabled: boolean) {
  const [schools, setSchools] = useState<SchoolHeadcount[]>([])
  const [status, setStatus] = useState<Status>('connecting')

  useEffect(() => {
    if (!enabled) return
    const session = readSession()
    if (!session) return

    const source = new EventSource(
      `/api/attendance/stream?token=${encodeURIComponent(session.token)}`,
    )

    source.addEventListener('headcount', (e) => {
      try {
        const data = JSON.parse((e as MessageEvent).data) as {
          schools?: SchoolHeadcount[]
        }
        if (Array.isArray(data.schools)) setSchools(data.schools)
      } catch {
        /* a malformed frame shouldn't blank the tile */
      }
      setStatus('live')
    })

    source.addEventListener('heartbeat', () => setStatus('live'))
    source.onopen = () => setStatus('live')
    // EventSource reconnects on its own. Surface the gap instead of hiding it:
    // an admin trusting a frozen headcount is worse than one who knows.
    source.onerror = () => setStatus('offline')

    return () => source.close()
  }, [enabled])

  return { schools, status }
}
