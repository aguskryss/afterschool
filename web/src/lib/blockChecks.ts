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
}

/**
 * One string per confirmation, so membership is a Set lookup rather than a scan
 * of every row on every render. A 16-child class re-rendering on each tap would
 * otherwise walk the whole list once per row.
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
      return new Set(
        res.checks.map((c) =>
          checkKey(
            c.kind === 'room'
              ? { kind: 'room', id: c.id, time_block: c.time_block ?? '' }
              : { kind: c.kind, id: c.id },
            c.child_id,
          ),
        ),
      )
    },
    enabled: Boolean(date),
  })
}

export type SetChecksInput = {
  block: BlockRef
  childIds: number[]
  present: boolean
}

/**
 * One tap, or a whole destination group at once.
 *
 * Optimistic, for the same reason the school-gate mark is: a counselor routing
 * a class at the door cannot wait on a round trip between taps, and "route all
 * 9" has to look done the instant it is pressed. The rollback restores the
 * exact previous Set rather than inverting the change, so two taps racing each
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
      const prev = qc.getQueryData<Set<string>>(key)
      const next = new Set(prev ?? [])
      for (const id of childIds) {
        const k = checkKey(block, id)
        if (present) next.add(k)
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
