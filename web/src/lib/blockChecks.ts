/**
 * Confirming a child inside a class or a care room.
 *
 * Separate from `lib/roster.ts` on purpose: that one is the school gate, one
 * mark per child per day. This is the afternoon, where the same child is asked
 * about again in every block they pass through — and the chained child (R3) is
 * legitimately confirmed twice, for two different reasons.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query'
import { api } from '@/lib/api'

export type BlockRef =
  | { kind: 'class'; id: number; time_block?: null }
  | { kind: 'room'; id: number; time_block: string }
  | { kind: 'school'; id: number; time_block?: null }

type Check = {
  kind: 'class' | 'room' | 'school'
  id: number
  time_block: string | null
  child_id: number
  checked_at: string | null
  routed_at: string | null
}

/**
 * When a confirmation happened, and whether it was ever routed onward.
 *
 * `failed` is a tap the server never accepted, even after retrying. It stays
 * on the row — in red, "not saved" — instead of the check quietly vanishing,
 * which is what counselors were seeing and reading as "it un-ticked itself".
 * A failed entry is NOT a confirmation: use isChecked(), never `.has()`.
 */
export type CheckState = {
  checked_at: string | null
  routed_at: string | null
  failed?: boolean
}

/**
 * One string per confirmation, so membership is a Map lookup rather than a
 * scan of every row on every render. A 16-child class re-rendering on each
 * tap would otherwise walk the whole list once per row.
 */
export function checkKey(block: BlockRef, childId: number): string {
  return `${block.kind}:${block.id}:${block.time_block ?? ''}:${childId}`
}

/** Confirmed here — optimistically or on the server — and not a failed tap. */
export function isChecked(
  checks: Map<string, CheckState> | undefined,
  key: string,
): boolean {
  const state = checks?.get(key)
  return Boolean(state && !state.failed)
}

/* ── Taps not yet on the server ──────────────────────────────────────── */

/**
 * What this device has asked for and the server has not confirmed yet, per
 * date. A refetch can land while a tap is still in flight (the screen
 * remounting, the tab regaining focus); without this it would paint the
 * server's older answer over the tap and un-tick a child for a moment — or,
 * for a tap that failed, erase the only sign that it did. Every fetch lays
 * these back over what the server returned.
 */
type Pending = {
  present: Map<string, boolean>
  routed: Map<string, boolean>
  /** Keys whose "here" tap failed; kept until the next tap on that child. */
  failed: Set<string>
}
const pendingByDate = new Map<string, Pending>()

function pendingFor(date: string | undefined): Pending {
  const k = date ?? ''
  let p = pendingByDate.get(k)
  if (!p) {
    p = { present: new Map(), routed: new Map(), failed: new Set() }
    pendingByDate.set(k, p)
  }
  return p
}

function applyPending(map: Map<string, CheckState>, p: Pending) {
  for (const k of p.failed) {
    if (!map.has(k)) map.set(k, { checked_at: null, routed_at: null, failed: true })
  }
  for (const [k, present] of p.present) {
    if (present) {
      if (!map.get(k) || map.get(k)!.failed) {
        map.set(k, { checked_at: optimisticNow(), routed_at: null })
      }
    } else {
      map.delete(k)
    }
  }
  for (const [k, routed] of p.routed) {
    const existing = map.get(k)
    if (existing && !existing.failed) {
      map.set(k, {
        ...existing,
        routed_at: routed ? (existing.routed_at ?? optimisticNow()) : null,
      })
    }
  }
}

export function useBlockChecks(date: string | undefined) {
  return useQuery({
    queryKey: ['counselor', 'block-checks', date],
    queryFn: async () => {
      const res = await api<{ checks: Check[] }>(
        `/api/counselor/block-checks?date=${date}`,
      )
      const map = new Map<string, CheckState>()
      for (const c of res.checks) {
        const key = checkKey(
          c.kind === 'room'
            ? { kind: 'room', id: c.id, time_block: c.time_block ?? '' }
            : { kind: c.kind, id: c.id },
          c.child_id,
        )
        map.set(key, { checked_at: c.checked_at, routed_at: c.routed_at })
      }
      applyPending(map, pendingFor(date))
      return map
    },
    enabled: Boolean(date),
  })
}

export type SetChecksInput = {
  block: BlockRef
  childIds: number[]
  present: boolean
}

/** A placeholder timestamp for the optimistic update — the real one lands on
 *  the refetch after the last tap settles. */
function optimisticNow(): string {
  return new Date().toISOString()
}

/**
 * How every tap on this screen goes to the server.
 *
 * - One `scope`: taps are sent one at a time, in the order they were made.
 *   That is what makes retrying safe — a "here" retried after the "undo"
 *   that followed it would otherwise land last and win.
 * - Retried: both writes are idempotent (an insert that ignores a duplicate,
 *   a delete, an update to a fixed value), so a second attempt after a
 *   dropped request or a busy server cannot double anything.
 * - Refetched once, after the LAST queued tap settles, not after each one.
 *   Refetching per tap raced the next tap still in flight and briefly
 *   un-ticked it, which looked exactly like the bug this file was fixing.
 */
function writeOptions(date: string | undefined) {
  return {
    mutationKey: ['counselor', 'block-checks', 'write', date],
    scope: { id: `block-checks:${date ?? ''}` },
    retry: 3,
    retryDelay: (attempt: number) => Math.min(600 * 2 ** attempt, 4000),
  }
}

function refetchWhenIdle(qc: QueryClient, date: string | undefined) {
  // Still counts the mutation whose onSettled is running, hence 1.
  if (qc.isMutating({ mutationKey: ['counselor', 'block-checks', 'write', date] }) <= 1) {
    void qc.invalidateQueries({ queryKey: ['counselor', 'block-checks', date] })
  }
}

type Rollback = { keys: string[]; prev: (CheckState | undefined)[] }

/**
 * One tap, or a whole destination group at once — the green "here" control.
 *
 * Optimistic, for the same reason the school-gate mark is: a counselor routing
 * a class at the door cannot wait on a round trip between taps, and "route all
 * 9" has to look done the instant it is pressed.
 *
 * A failure touches only the children in that tap. A "here" that could not be
 * saved stays on the row marked failed; an undo that could not be saved puts
 * back exactly what those children showed before. It used to restore a
 * snapshot of the whole block, which also erased every tap made after it.
 */
export function useSetBlockChecks(date: string | undefined) {
  const qc = useQueryClient()
  const key = ['counselor', 'block-checks', date]

  return useMutation({
    ...writeOptions(date),
    mutationFn: ({ block, childIds, present }: SetChecksInput) =>
      api('/api/counselor/block-checks', {
        method: 'POST',
        body: {
          date,
          block: {
            kind: block.kind,
            id: block.id,
            time_block: block.time_block ?? null,
          },
          child_ids: childIds,
          present,
        },
      }),
    onMutate: async ({ block, childIds, present }): Promise<Rollback> => {
      await qc.cancelQueries({ queryKey: key })
      const pending = pendingFor(date)
      const current = qc.getQueryData<Map<string, CheckState>>(key)
      const next = new Map(current ?? [])
      const keys = childIds.map((id) => checkKey(block, id))
      const prev = keys.map((k) => current?.get(k))
      for (const k of keys) {
        pending.failed.delete(k)
        pending.present.set(k, present)
        // Undoing "here" undoes "routed" with it — see the POST route: a
        // present:false DELETE clears the whole row, routed_at included.
        pending.routed.delete(k)
        if (present) next.set(k, { checked_at: optimisticNow(), routed_at: null })
        else next.delete(k)
      }
      qc.setQueryData(key, next)
      return { keys, prev }
    },
    onSuccess: (_d, { present }, ctx) => {
      const pending = pendingFor(date)
      for (const k of ctx.keys) {
        // A later tap on the same child owns the entry now; leave it be.
        if (pending.present.get(k) === present) pending.present.delete(k)
      }
    },
    onError: (_e, { present }, ctx) => {
      if (!ctx) return
      const pending = pendingFor(date)
      const next = new Map(qc.getQueryData<Map<string, CheckState>>(key) ?? [])
      ctx.keys.forEach((k, i) => {
        if (pending.present.get(k) !== present) return
        pending.present.delete(k)
        if (present) {
          pending.failed.add(k)
          next.set(k, { checked_at: null, routed_at: null, failed: true })
        } else {
          const before = ctx.prev[i]
          if (before) next.set(k, before)
        }
      })
      qc.setQueryData(key, next)
    },
    onSettled: () => refetchWhenIdle(qc, date),
  })
}

export type SetRoutedInput = {
  block: BlockRef
  childIds: number[]
  routed: boolean
}

/**
 * The blue "walked to their next class or CARE room" control.
 *
 * Only ever an UPDATE server-side, never an INSERT (sql/63): a child with no
 * row yet — nobody has confirmed them here — is a silent no-op, exactly like
 * the school-gate mark tolerates a second tap. The optimistic write mirrors
 * that by leaving a child with no existing entry untouched rather than
 * inventing one.
 */
export function useSetRouted(date: string | undefined) {
  const qc = useQueryClient()
  const key = ['counselor', 'block-checks', date]

  return useMutation({
    ...writeOptions(date),
    mutationFn: ({ block, childIds, routed }: SetRoutedInput) =>
      api('/api/counselor/block-checks', {
        method: 'POST',
        body: {
          date,
          block: {
            kind: block.kind,
            id: block.id,
            time_block: block.time_block ?? null,
          },
          child_ids: childIds,
          routed,
        },
      }),
    onMutate: async ({ block, childIds, routed }): Promise<Rollback> => {
      await qc.cancelQueries({ queryKey: key })
      const pending = pendingFor(date)
      const current = qc.getQueryData<Map<string, CheckState>>(key)
      const next = new Map(current ?? [])
      const keys = childIds.map((id) => checkKey(block, id))
      const prev = keys.map((k) => current?.get(k))
      for (const k of keys) {
        const existing = next.get(k)
        if (!existing || existing.failed) continue
        pending.routed.set(k, routed)
        next.set(k, { ...existing, routed_at: routed ? optimisticNow() : null })
      }
      qc.setQueryData(key, next)
      return { keys, prev }
    },
    onSuccess: (_d, { routed }, ctx) => {
      const pending = pendingFor(date)
      for (const k of ctx.keys) {
        if (pending.routed.get(k) === routed) pending.routed.delete(k)
      }
    },
    onError: (_e, { routed }, ctx) => {
      if (!ctx) return
      const pending = pendingFor(date)
      const next = new Map(qc.getQueryData<Map<string, CheckState>>(key) ?? [])
      ctx.keys.forEach((k, i) => {
        if (pending.routed.get(k) !== routed) return
        pending.routed.delete(k)
        const now = next.get(k)
        const before = ctx.prev[i]
        if (now && !now.failed) next.set(k, { ...now, routed_at: before?.routed_at ?? null })
      })
      qc.setQueryData(key, next)
    },
    onSettled: () => refetchWhenIdle(qc, date),
  })
}
