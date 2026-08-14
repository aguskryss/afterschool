import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, Check, Clock, Target, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { hasModule } from '@/lib/auth'
import { Button, Card, EmptyState, Field, Pill, Skeleton } from '@/components/ui'

type Activity = {
  id: number
  child_name: string
  school: string
  grade_group: string | null
  action: string
  day_of_week: string
  action_time: string | null
  specific_date: string | null
  activity_name: string
  category: string | null
  completed: boolean
}

type TimeOff = {
  id: number
  off_date: string
  reason: string | null
  status: 'pending' | 'approved' | 'rejected'
  review_note: string | null
}

const STATUS_TONE = {
  pending: 'sun',
  approved: 'leaf',
  rejected: 'berry',
} as const

/**
 * Activity drop-offs and pickups.
 *
 * Its own component because the whole section disappears for a JCC without the
 * activities module — and with it the queries, which the server would refuse.
 */
function ActivitiesSection() {
  const qc = useQueryClient()
  const [scope, setScope] = useState<'today' | 'week'>('today')

  const { data: activities, isPending } = useQuery({
    queryKey: ['counselor', 'activities', scope],
    queryFn: () =>
      api<Activity[]>(
        `/api/counselor/activities${scope === 'week' ? '?day=week' : ''}`,
      ),
  })

  const complete = useMutation({
    mutationFn: (id: number) =>
      api(`/api/counselor/activities/${id}/complete`, { method: 'POST' }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['counselor', 'activities'] }),
  })

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[0.95rem] font-extrabold text-ink-700">
          Drop-offs &amp; pickups
        </h2>
        <div
          role="tablist"
          aria-label="Range"
          className="flex rounded-full bg-canvas-100 p-1"
        >
          {(['today', 'week'] as const).map((s) => (
            <button
              key={s}
              role="tab"
              aria-selected={scope === s}
              onClick={() => setScope(s)}
              className={`rounded-full px-3.5 py-1.5 text-[0.82rem] font-bold capitalize transition ${
                scope === s
                  ? 'bg-white text-ink-900 shadow-soft'
                  : 'text-ink-500'
              }`}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {isPending ? (
        <Skeleton className="mb-6 h-36" />
      ) : !activities?.length ? (
        <Card className="mb-6">
          <EmptyState
            icon={<Target className="size-7" strokeWidth={1.8} />}
            title="Nothing assigned"
            body={
              scope === 'today'
                ? 'You have no activity drop-offs or pickups today.'
                : 'Nothing assigned for the coming week.'
            }
          />
        </Card>
      ) : (
        <Card className="mb-6 overflow-hidden">
          <ul className="divide-y divide-canvas-200">
            {activities.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                <span
                  className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
                    a.completed
                      ? 'bg-leaf-50 text-leaf-500'
                      : 'bg-grape-50 text-grape-500'
                  }`}
                >
                  <Target className="size-5" strokeWidth={2.1} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-bold text-ink-900">
                    {a.child_name}
                  </p>
                  <p className="truncate text-[0.82rem] font-medium text-ink-500">
                    {a.action} · {a.activity_name}
                    {a.action_time ? ` · ${a.action_time}` : ''}
                  </p>
                </div>
                {a.completed ? (
                  <Pill status="leaf">Done</Pill>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    loading={complete.isPending && complete.variables === a.id}
                    onClick={() => complete.mutate(a.id)}
                  >
                    <Check className="size-4" strokeWidth={2.8} />
                    Done
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  )
}

/**
 * Schedule: the counselor's own week.
 *
 * Two things live here because both answer "what am I responsible for that
 * isn't today's roster": the activity drop-offs and pickups they owe, and the
 * days off they've asked for.
 */
export function CounselorSchedule() {
  const qc = useQueryClient()
  const [offDate, setOffDate] = useState('')
  const [reason, setReason] = useState('')
  const [formError, setFormError] = useState('')
  const [showForm, setShowForm] = useState(false)

  const { data: timeOff } = useQuery({
    queryKey: ['counselor', 'time-off'],
    queryFn: () => api<TimeOff[]>('/api/counselor/time-off'),
  })

  const requestOff = useMutation({
    mutationFn: () =>
      api('/api/counselor/time-off', {
        method: 'POST',
        body: { off_date: offDate, reason },
      }),
    onSuccess: () => {
      setOffDate('')
      setReason('')
      setShowForm(false)
      setFormError('')
      void qc.invalidateQueries({ queryKey: ['counselor', 'time-off'] })
    },
    // 409 means a request for that date already exists — worth saying plainly
    // rather than showing a generic failure.
    onError: (err) =>
      setFormError(
        err instanceof ApiError
          ? err.message
          : 'Could not send the request. Try again.',
      ),
  })

  const cancelOff = useMutation({
    mutationFn: (id: number) =>
      api(`/api/counselor/time-off/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['counselor', 'time-off'] }),
  })

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <h1 className="mb-4 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Schedule
      </h1>

      {hasModule('activities') && <ActivitiesSection />}

      {/* ── Days off ── */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[0.95rem] font-extrabold text-ink-700">Days off</h2>
        <Button size="sm" onClick={() => setShowForm((v) => !v)}>
          <CalendarPlus className="size-4" strokeWidth={2.4} />
          Request
        </Button>
      </div>

      {showForm && (
        <Card className="mb-3 p-4">
          <Field
            label="Date"
            type="date"
            value={offDate}
            onChange={(e) => setOffDate(e.target.value)}
            className="mb-3"
          />
          <Field
            label="Reason"
            placeholder="Optional"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="mb-4"
          />
          {formError && (
            <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
              {formError}
            </p>
          )}
          <Button
            full
            disabled={!offDate}
            loading={requestOff.isPending}
            onClick={() => requestOff.mutate()}
          >
            Send request
          </Button>
        </Card>
      )}

      {!timeOff?.length ? (
        <Card>
          <EmptyState
            icon={<Clock className="size-7" strokeWidth={1.8} />}
            title="No days off requested"
            body="Requests you send go to an administrator for approval."
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-canvas-200">
            {timeOff.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold text-ink-900">
                    {new Date(`${t.off_date}T12:00:00`).toLocaleDateString(
                      'en-US',
                      { weekday: 'short', month: 'short', day: 'numeric' },
                    )}
                  </p>
                  <p className="truncate text-[0.82rem] font-medium text-ink-500">
                    {t.review_note || t.reason || 'No reason given'}
                  </p>
                </div>
                <Pill status={STATUS_TONE[t.status]}>{t.status}</Pill>
                {t.status === 'pending' && (
                  <button
                    type="button"
                    aria-label="Cancel request"
                    onClick={() => cancelOff.mutate(t.id)}
                    className="flex size-9 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-berry-50 hover:text-berry-500"
                  >
                    <Trash2 className="size-4" strokeWidth={2.1} />
                  </button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  )
}
