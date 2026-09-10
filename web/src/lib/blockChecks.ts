/**
 * Confirming a child inside a class or a care room.
 *
 * Separate from `lib/roster.ts` on purpose: that one is the school gate, one
 * mark per child per day. This is the afternoon, where the same child is asked
 * about again in every block they pass through — and the chained child (R3) is
 * legitimately confirmed twice, for two different reasons.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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

/** When a confirmation happened, and whether it was ever routed onward. */
export type CheckState = { checked_at: string | null; routed_at: string | null }

/**
 * One string per confirmation, so membership is a Map lookup rather than a
 * scan of every row on every render. A 16-child class re-rendering on each
 * tap would otherwise walk the whole list once per row.
 */
export function checkKey(block: BlockRef, childId: number): string {
  return `${block.kind}:${block.id}:${block.time_block ?? ''}:${childId}`
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
 *  the next refetch (onSettled), this is only what the tap shows meanwhile. */
function optimisticNow(): string {
  return new Date().toISOString()
}

/**
 * One tap, or a whole destination group at once — the green "here" control.
 *
 * Optimistic, for the same reason the school-gate mark is: a counselor routing
 * a class at the door cannot wait on a round trip between taps, and "route all
 * 9" has to look done the instant it is pressed. The rollback restores the
 * exact previous Map rather than inverting the change, so two taps racing each
 * other cannot leave a child confirmed who never was.
 */
export function useSetBlockChecks(date: string | undefined) {
  const qc = useQueryClient()
  const key = ['counselor', 'block-checks', date]

  return useMutation({
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
    onMutate: async ({ block, childIds, present }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<Map<string, CheckState>>(key)
      const next = new Map(prev ?? [])
      for (const id of childIds) {
        const k = checkKey(block, id)
        // Undoing "here" undoes "routed" with it — see the POST route: a
        // present:false DELETE clears the whole row, routed_at included.
        if (present) next.set(k, { checked_at: optimisticNow(), routed_at: null })
        else next.delete(k)
      }
      qc.setQueryData(key, next)
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
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
    onMutate: async ({ block, childIds, routed }) => {
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<Map<string, CheckState>>(key)
      const next = new Map(prev ?? [])
      for (const id of childIds) {
        const k = checkKey(block, id)
        const existing = next.get(k)
        if (!existing) continue
        next.set(k, { ...existing, routed_at: routed ? optimisticNow() : null })
      }
      qc.setQueryData(key, next)
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
}
