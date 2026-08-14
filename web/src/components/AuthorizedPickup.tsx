import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Plus, ShieldCheck, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Field } from '@/components/ui'

export type AuthorizedPerson = {
  id: number
  child_id: number
  name: string
  relationship: string | null
  child_name?: string
}

/** Shared across every child card, so the list is fetched once per screen. */
const QUERY_KEY = ['parent', 'authorized-pickups']

/** "Mateo", "Mateo and Ana", "Mateo, Ana and Leo" */
function nameList(names: string[]): string {
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/**
 * The people a parent says may collect one child.
 *
 * Rendered inside each child's card rather than on a settings screen of its
 * own: the question "who can pick up Sofia" only makes sense next to Sofia,
 * and a parent with three children would otherwise have to keep three lists
 * straight in one place.
 *
 * The parent themselves is not on this list and does not need to be — staff
 * always see the registered parent as an option (see ReleaseChild).
 *
 * Adding and editing apply to every one of the parent's children, because
 * whoever may collect one of them almost always may collect all of them.
 * Removing does not: it stays per child, so "she picks up the older one only"
 * is still sayable, and one card's × can never quietly strip an authorization
 * off a sibling.
 */
export function AuthorizedPickup({
  childId,
  siblings = [],
}: {
  childId: number
  /** Names of this parent's other children, for the fan-out notice. */
  siblings?: string[]
}) {
  const qc = useQueryClient()
  // null = closed, 'new' = adding, a number = editing that person.
  const [form, setForm] = useState<'new' | number | null>(null)
  const [name, setName] = useState('')
  const [relationship, setRelationship] = useState('')
  const [error, setError] = useState('')

  const { data: people } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => api<AuthorizedPerson[]>('/api/parent/authorized-pickups'),
  })

  const mine = (people ?? []).filter((p) => p.child_id === childId)

  const reset = () => {
    setName('')
    setRelationship('')
    setError('')
    setForm(null)
  }

  const openEdit = (p: AuthorizedPerson) => {
    setName(p.name)
    setRelationship(p.relationship ?? '')
    setError('')
    setForm(p.id)
  }

  const onError = (fallback: string) => (err: unknown) =>
    setError(err instanceof ApiError ? err.message : fallback)

  const save = useMutation({
    mutationFn: () =>
      form === 'new'
        ? api('/api/parent/authorized-pickups', {
            method: 'POST',
            body: { child_id: childId, name, relationship },
          })
        : api(`/api/parent/authorized-pickups/${form}`, {
            method: 'PATCH',
            body: { name, relationship },
          }),
    onSuccess: () => {
      reset()
      void qc.invalidateQueries({ queryKey: QUERY_KEY })
    },
    onError: onError('Could not save that person.'),
  })

  const remove = useMutation({
    mutationFn: (id: number) =>
      api(`/api/parent/authorized-pickups/${id}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: QUERY_KEY }),
  })

  return (
    <div className="mt-3.5 border-t border-canvas-200 pt-3.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-teal-500">
          <ShieldCheck className="size-[1.15rem]" strokeWidth={2.2} />
        </span>
        <p className="text-[0.85rem] font-bold text-ink-600">Who can pick up</p>
      </div>

      {mine.length === 0 ? (
        <p className="mb-2 px-1 text-[0.82rem] font-medium text-ink-400">
          Nobody added yet. You can always collect your own child — add anyone
          else who may, and staff will release only to them.
        </p>
      ) : (
        <ul className="mb-2 flex flex-wrap gap-1.5">
          {mine.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-1 rounded-full bg-canvas-100 py-1 pr-1 pl-2.5"
            >
              <span className="text-[0.82rem] font-bold text-ink-700">
                {p.name}
                {p.relationship && (
                  <span className="font-medium text-ink-400">
                    {' '}
                    · {p.relationship}
                  </span>
                )}
              </span>
              <button
                type="button"
                aria-label={`Edit ${p.name}`}
                onClick={() => openEdit(p)}
                className="flex size-5 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-canvas-200 hover:text-ink-700"
              >
                <Pencil className="size-3" strokeWidth={2.6} />
              </button>
              <button
                type="button"
                aria-label={`Remove ${p.name}`}
                onClick={() => remove.mutate(p.id)}
                className="flex size-5 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-canvas-200 hover:text-ink-700"
              >
                <X className="size-3.5" strokeWidth={2.8} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {form !== null ? (
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) save.mutate()
          }}
          className="flex flex-col gap-2"
        >
          <Field
            label="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Grandma Ruth"
            autoFocus
          />
          <Field
            label="Relationship"
            value={relationship}
            onChange={(e) => setRelationship(e.target.value)}
            placeholder="Grandmother"
          />
          {/* Said at the moment of the decision, and it names the siblings —
              a parent has to be able to see that they just authorized someone
              for another child, not discover it later. */}
          {siblings.length > 0 && (
            <p className="px-1 text-[0.78rem] font-medium text-ink-400">
              {form === 'new'
                ? `Also added for ${nameList(siblings)}. Remove them from that card if they shouldn't collect them.`
                : `This also updates ${nameList(siblings)}.`}
            </p>
          )}
          {error && (
            <p className="text-[0.82rem] font-semibold text-berry-600">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button
              type="submit"
              size="sm"
              loading={save.isPending}
              disabled={!name.trim()}
            >
              {form === 'new' ? 'Add' : 'Save'}
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={reset}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setName('')
            setRelationship('')
            setError('')
            setForm('new')
          }}
          className="flex items-center gap-1.5 rounded-2xl px-2 py-1.5 text-[0.82rem] font-bold text-ink-600 transition-colors hover:bg-canvas-100 active:bg-canvas-200"
        >
          <Plus className="size-4" strokeWidth={2.8} />
          Add someone
        </button>
      )}
    </div>
  )
}
