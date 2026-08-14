import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellRing, Clock, Send } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Card, Skeleton } from '@/components/ui'

type Catalogue = {
  key: string
  label: string
  description: string
  default: boolean
}

type Settings = {
  catalogue: Catalogue[]
  notifications: Record<string, boolean>
  attendance_check_at: string | null
  timezone: string
}

/**
 * What this JCC's parents hear about, and when.
 *
 * The catalogue is rendered from the server's list rather than a copy here, so
 * an event added in tenancy.PARENT_NOTIFICATIONS appears on this screen without
 * a frontend change — and cannot silently go missing from it either.
 *
 * These belong to the JCC's own administrator, unlike the module toggles in the
 * platform console. A module is what a JCC bought; this is how it runs its
 * afternoon.
 */
export function AdminNotifications() {
  const qc = useQueryClient()
  const [prefs, setPrefs] = useState<Record<string, boolean> | null>(null)
  const [time, setTime] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'notification-settings'],
    queryFn: () => api<Settings>('/api/admin/notification-settings'),
  })

  // Seeded once from the server and edited locally afterwards, so a toggle
  // does not flicker back while its save is in flight.
  useEffect(() => {
    if (data && prefs === null) {
      setPrefs(data.notifications)
      setTime(data.attendance_check_at ?? '')
    }
  }, [data, prefs])

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api<{ notifications: Record<string, boolean>; attendance_check_at: string | null }>(
        '/api/admin/notification-settings',
        { method: 'PUT', body },
      ),
    onSuccess: (d) => {
      setError('')
      setPrefs(d.notifications)
      setTime(d.attendance_check_at ?? '')
      void qc.invalidateQueries({ queryKey: ['admin', 'notification-settings'] })
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  })

  const runNow = useMutation({
    mutationFn: () =>
      api<{ asked: number }>('/api/admin/notification-settings/run-now', {
        method: 'POST',
      }),
    onSuccess: (d) =>
      setNote(
        d.asked === 0
          ? 'Nobody needed asking — every family expected today has already answered.'
          : `Asked ${d.asked} ${d.asked === 1 ? 'family' : 'families'}.`,
      ),
    onError: (e) =>
      setNote(e instanceof ApiError ? e.message : 'Could not send it.'),
  })

  if (isPending || !data || prefs === null) {
    return (
      <div className="mx-auto w-full max-w-3xl">
        <Skeleton className="h-64" />
      </div>
    )
  }

  const toggle = (key: string) => {
    const next = { ...prefs, [key]: !prefs[key] }
    setPrefs(next)
    save.mutate({ notifications: next })
  }

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Notifications
      </h1>
      <p className="mb-6 text-[0.92rem] font-medium text-ink-500">
        What your families get a phone notification about. Turning one off does
        not stop the thing happening — a pickup still gets recorded — only the
        alert about it.
      </p>

      <Card className="mb-4 p-4">
        <p className="mb-3 font-extrabold text-ink-800">Parents are notified when…</p>
        <ul className="flex flex-col divide-y divide-canvas-200">
          {data.catalogue.map((item) => {
            const on = prefs[item.key] ?? item.default
            return (
              <li key={item.key} className="flex items-start justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="font-bold text-ink-800">{item.label}</p>
                  <p className="text-[0.85rem] font-medium text-ink-500">
                    {item.description}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={item.label}
                  onClick={() => toggle(item.key)}
                  className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors ${
                    on ? 'bg-leaf-500' : 'bg-canvas-200'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 size-5 rounded-full bg-white shadow-soft transition-all ${
                      on ? 'left-[1.375rem]' : 'left-0.5'
                    }`}
                  />
                </button>
              </li>
            )
          })}
        </ul>
        {error && (
          <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
            {error}
          </p>
        )}
      </Card>

      <Card className="p-4">
        <div className="mb-1 flex items-center gap-2">
          <Clock className="size-4 text-ink-400" strokeWidth={2.2} />
          <p className="font-extrabold text-ink-800">Daily attendance check</p>
        </div>
        <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
          Asks every family whose child is expected today and has not answered
          yet. Leave it empty and nothing is sent on a schedule — a counselor
          can still ask child by child.
        </p>

        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label
              htmlFor="attendance-time"
              className="mb-1.5 block text-sm font-bold text-ink-700"
            >
              Send at
            </label>
            <input
              id="attendance-time"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="rounded-2xl border-2 border-canvas-200 px-4 py-2 text-[0.95rem] font-semibold text-ink-900 outline-none focus:border-grape-500"
            />
          </div>
          <Button
            loading={save.isPending}
            onClick={() => save.mutate({ attendance_check_at: time })}
          >
            Save time
          </Button>
          {time && (
            <Button
              variant="ghost"
              onClick={() => {
                setTime('')
                save.mutate({ attendance_check_at: '' })
              }}
            >
              Turn off
            </Button>
          )}
        </div>

        {/* The timezone is the organization's, not the viewer's. An admin
            checking from another state should not have to work that out. */}
        <p className="mt-2 text-[0.8rem] font-medium text-ink-400">
          {time
            ? `Sent at ${time} ${data.timezone.replace('_', ' ')} time, every day.`
            : 'Not scheduled.'}
        </p>

        <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-canvas-200 pt-3">
          <Button
            variant="outline"
            size="sm"
            loading={runNow.isPending}
            onClick={() => runNow.mutate()}
          >
            <Send className="size-3.5" strokeWidth={2.4} />
            Send it now
          </Button>
          {note ? (
            <span className="text-[0.85rem] font-semibold text-ink-600">{note}</span>
          ) : (
            <span className="text-[0.82rem] font-medium text-ink-400">
              Sends to today's unanswered families right away.
            </span>
          )}
        </div>

        {!prefs.attendance_check && (
          <p className="mt-3 flex items-start gap-2 rounded-xl bg-sun-50 p-3 text-[0.84rem] font-semibold text-sun-700">
            <BellRing className="mt-0.5 size-4 shrink-0" strokeWidth={2.2} />
            {/* The two settings can contradict each other, and the schedule is
                the one that loses. Better to say so than to let someone set a
                time and wonder why nothing arrives. */}
            The attendance-check notification is switched off above, so this
            schedule will record the question in the app but send no alert.
          </p>
        )}
      </Card>
    </div>
  )
}
