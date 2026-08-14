import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, ShieldCheck, UserCheck } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Card, Pill } from '@/components/ui'
import { SignaturePad } from '@/components/SignaturePad'

type Person = {
  /** null for the registered parent, who is on the list implicitly. */
  id: number | null
  name: string
  relationship: string | null
  is_parent: boolean
}

type Released = {
  person_name: string
  person_relationship: string | null
  counselor_name: string
  released_at: string
  has_signature: boolean
}

function timeOf(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Confirming who collected a child, and taking their signature.
 *
 * Two steps, not one. The counselor picks from the parent's list rather than
 * typing a name — a free-text field would record whoever the person at the
 * door said they were, which is the thing this whole flow exists to stop — and
 * then that person signs. The signature is what makes the record hold up later
 * when someone asks who took a child home, so it is required, not offered.
 */
export function ReleaseChild({
  childId,
  childName,
  date,
  onDone,
}: {
  childId: number
  childName: string
  date: string
  onDone: () => void
}) {
  const qc = useQueryClient()
  const [error, setError] = useState('')
  const [picked, setPicked] = useState<Person | null>(null)
  const [signature, setSignature] = useState<string | null>(null)

  const { data, isPending } = useQuery({
    queryKey: ['counselor', 'authorized-pickups', childId],
    queryFn: () =>
      api<{ people: Person[]; released: Released | null }>(
        `/api/counselor/authorized-pickups?child_id=${childId}`,
      ),
  })

  const release = useMutation({
    mutationFn: () =>
      api('/api/counselor/pickup/release', {
        method: 'POST',
        body: { child_id: childId, person_id: picked?.id ?? null, signature },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['counselor', 'roster'] })
      void qc.invalidateQueries({ queryKey: ['counselor', 'attendance', date] })
      void qc.invalidateQueries({
        queryKey: ['counselor', 'authorized-pickups', childId],
      })
      onDone()
    },
    // A 409 means someone else already released this child. That is worth
    // reading in full rather than reducing to "failed" — it names who took
    // them and which counselor confirmed it.
    onError: (err) =>
      setError(
        err instanceof ApiError
          ? err.message
          : 'Could not record the pickup. Try again.',
      ),
  })

  if (isPending) {
    return (
      <Card className="mt-2 p-3">
        <p className="text-[0.85rem] font-semibold text-ink-400">Loading…</p>
      </Card>
    )
  }

  if (data?.released) {
    return (
      <Card className="mt-2 bg-leaf-50 p-3">
        <p className="flex items-center gap-2 text-[0.88rem] font-bold text-leaf-700">
          <UserCheck className="size-4" strokeWidth={2.4} />
          Picked up by {data.released.person_name} at{' '}
          {timeOf(data.released.released_at)}
        </p>
        <p className="mt-0.5 pl-6 text-[0.8rem] font-medium text-ink-500">
          Confirmed by {data.released.counselor_name}
        </p>
      </Card>
    )
  }

  const people = data?.people ?? []

  // ─── Step 2: sign ─────────────────────────────────────────────────────────
  if (picked) {
    return (
      <Card className="mt-2 p-3">
        <button
          type="button"
          onClick={() => {
            setPicked(null)
            setSignature(null)
            setError('')
          }}
          className="mb-2 flex items-center gap-1 text-[0.8rem] font-bold text-ink-500 transition-colors hover:text-ink-700"
        >
          <ChevronLeft className="size-4" strokeWidth={2.8} />
          Someone else
        </button>

        <p className="mb-2 text-[0.85rem] font-bold text-ink-700">
          {picked.name} is taking {childName}
          {picked.relationship && (
            <span className="font-medium text-ink-400"> · {picked.relationship}</span>
          )}
        </p>

        <SignaturePad onChange={setSignature} disabled={release.isPending} />

        {error && (
          <p className="mt-2 text-[0.82rem] font-semibold text-berry-600">
            {error}
          </p>
        )}

        <Button
          size="sm"
          full
          className="mt-2.5"
          loading={release.isPending}
          disabled={!signature}
          onClick={() => release.mutate()}
        >
          Confirm pickup
        </Button>
      </Card>
    )
  }

  // ─── Step 1: who is collecting ────────────────────────────────────────────
  return (
    <Card className="mt-2 p-3">
      <p className="mb-2 flex items-center gap-2 text-[0.85rem] font-bold text-ink-700">
        <ShieldCheck className="size-4 text-teal-500" strokeWidth={2.4} />
        Who is collecting {childName}?
      </p>

      <ul className="flex flex-col gap-1.5">
        {people.map((p) => (
          <li key={p.id ?? 'parent'}>
            <button
              type="button"
              onClick={() => setPicked(p)}
              className="flex w-full items-center gap-2 rounded-2xl px-3 py-2.5 text-left transition-colors hover:bg-canvas-100 active:bg-canvas-200"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-ink-900">{p.name}</p>
                {p.relationship && (
                  <p className="truncate text-[0.8rem] font-medium text-ink-500">
                    {p.relationship}
                  </p>
                )}
              </div>
              {p.is_parent && <Pill status="leaf">Parent</Pill>}
            </button>
          </li>
        ))}
      </ul>

      {people.length === 1 && (
        <p className="mt-1.5 px-1 text-[0.78rem] font-medium text-ink-400">
          Only the parent is on this list. Anyone else has to be added by the
          parent from their own app first.
        </p>
      )}

      <Button size="sm" variant="outline" className="mt-2" onClick={onDone}>
        Cancel
      </Button>
    </Card>
  )
}
