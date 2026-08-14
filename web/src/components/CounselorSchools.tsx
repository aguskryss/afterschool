import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarClock, Plus, Trash2, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Card, Pill, Skeleton } from '@/components/ui'

export type Assignment = {
  school_id: number
  school: string
  effective_from: string | null
  effective_to: string | null
  permanent: boolean
  in_effect: boolean
  assigned_by_name: string | null
  assigned_at: string | null
}

type Response = {
  date: string
  /** No rows at all — which means every school, not none. */
  covers_all_schools: boolean
  schools: Assignment[]
}

type School = { id: number; name: string }

const SELECT =
  'h-10 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-semibold text-ink-800 outline-none focus:border-sky-500'
const DATE_INPUT =
  'h-10 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-semibold text-ink-800 outline-none focus:border-sky-500'

/** "Mon Aug 3" — short enough for a chip, unambiguous about the day. */
function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function windowLabel(a: Assignment): string {
  if (a.permanent) return 'Permanent'
  if (a.effective_from && a.effective_to)
    return a.effective_from === a.effective_to
      ? shortDate(a.effective_from)
      : `${shortDate(a.effective_from)} – ${shortDate(a.effective_to)}`
  if (a.effective_from) return `From ${shortDate(a.effective_from)}`
  return `Until ${shortDate(a.effective_to!)}`
}

/**
 * Assigning schools to a counselor, after they were created.
 *
 * Until now this could only be set once, in the add-counselor form, and never
 * changed — the endpoint existed and nothing in the app called it. The whole
 * point of the screen is the case the program actually hits every week:
 * somebody calls out, and a counselor covers their school for one afternoon
 * without losing their own.
 */
export function CounselorSchools({
  counselorId,
  counselorName,
  onClose,
}: {
  counselorId: number
  counselorName: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [school, setSchool] = useState('')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [error, setError] = useState('')

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'counselor-schools', counselorId],
    queryFn: () =>
      api<Response>(`/api/admin/counselors/${counselorId}/schools`),
  })

  const { data: schools } = useQuery({
    queryKey: ['admin', 'schools'],
    queryFn: () => api<School[]>('/api/admin/schools'),
  })

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['admin', 'counselor-schools', counselorId] })
    void qc.invalidateQueries({ queryKey: ['admin', 'counselors'] })
    void qc.invalidateQueries({ queryKey: ['admin', 'assignment-log'] })
  }

  const add = useMutation({
    mutationFn: () =>
      api(`/api/admin/counselors/${counselorId}/schools/${school}`, {
        method: 'POST',
        body: {
          effective_from: from || null,
          effective_to: to || null,
        },
      }),
    onSuccess: () => {
      setSchool('')
      setFrom('')
      setTo('')
      setError('')
      refresh()
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not assign it.'),
  })

  const remove = useMutation({
    mutationFn: (schoolId: number) =>
      api(`/api/admin/counselors/${counselorId}/schools/${schoolId}`, {
        method: 'DELETE',
      }),
    onSuccess: refresh,
  })

  const assigned = new Set((data?.schools ?? []).map((a) => a.school_id))
  const available = (schools ?? []).filter((s) => !assigned.has(s.id))

  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-extrabold text-ink-800">
          Schools for {counselorName}
        </p>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="rounded-full p-1.5 text-ink-400 hover:bg-canvas-100 hover:text-ink-700"
        >
          <X className="size-4" strokeWidth={2.4} />
        </button>
      </div>

      {isPending ? (
        <Skeleton className="h-20" />
      ) : data?.covers_all_schools ? (
        // An empty assignment list is fail-open, not fail-closed, and the
        // difference matters enough to spell out: this counselor can work
        // every school until somebody narrows them.
        <p className="mb-3 rounded-2xl bg-sun-50 px-4 py-3 text-[0.9rem] font-semibold text-sun-700">
          No schools assigned, so {counselorName.split(' ')[0]} currently sees
          <strong> every school</strong> in the program. Assign one below to
          narrow them.
        </p>
      ) : (
        <ul className="mb-3 flex flex-col gap-2">
          {data?.schools.map((a) => (
            <li
              key={a.school_id}
              className="flex flex-wrap items-center gap-2 rounded-2xl bg-canvas-100 px-3 py-2"
            >
              <span className="font-bold text-ink-900">{a.school}</span>
              {a.permanent ? (
                <Pill status="neutral">Permanent</Pill>
              ) : (
                <Pill status={a.in_effect ? 'leaf' : 'neutral'}>
                  <CalendarClock className="size-3" strokeWidth={2.6} />
                  {windowLabel(a)}
                </Pill>
              )}
              {!a.in_effect && !a.permanent && (
                <span className="text-[0.78rem] font-bold text-ink-400">
                  not today
                </span>
              )}
              <button
                type="button"
                aria-label={`Remove ${a.school}`}
                onClick={() => remove.mutate(a.school_id)}
                className="ms-auto rounded-full p-1.5 text-ink-400 hover:bg-berry-50 hover:text-berry-600"
              >
                <Trash2 className="size-4" strokeWidth={2.2} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2">
        <select
          value={school}
          onChange={(e) => setSchool(e.target.value)}
          aria-label="School to assign"
          className={SELECT}
        >
          <option value="">Add a school…</option>
          {available.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <label className="flex flex-col gap-1">
          <span className="text-[0.75rem] font-bold text-ink-500">From</span>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className={DATE_INPUT}
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[0.75rem] font-bold text-ink-500">Until</span>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className={DATE_INPUT}
          />
        </label>
        <Button
          size="sm"
          disabled={!school}
          loading={add.isPending}
          onClick={() => add.mutate()}
        >
          <Plus className="size-4" strokeWidth={2.6} />
          Assign
        </Button>
      </div>
      <p className="mt-2 text-[0.8rem] font-medium text-ink-400">
        Leave both dates empty for a permanent assignment. Fill them in to
        cover for someone without changing their standing schools.
      </p>

      {error && (
        <p className="mt-2 text-[0.85rem] font-bold text-berry-600">{error}</p>
      )}
    </Card>
  )
}
