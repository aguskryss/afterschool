import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Mail, MailX } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Card } from '@/components/ui'

type Prefs = { enabled: boolean; email: string }

/**
 * Email as a second notification channel, next to push on the same screen.
 *
 * Push already covers this (messages, photos, pickups, the attendance
 * check), but a device that never granted permission — or a subscription
 * that quietly went stale — never gets it. This is the fallback: the same
 * events, opt-in, delivered to the address a parent already logs in with.
 */
export function EmailNotificationsCard() {
  const qc = useQueryClient()
  const [error, setError] = useState('')

  const { data } = useQuery({
    queryKey: ['parent', 'email-notifications'],
    queryFn: () => api<Prefs>('/api/parent/email-notifications'),
  })

  const set = useMutation({
    mutationFn: (enabled: boolean) =>
      api<Prefs>('/api/parent/email-notifications', {
        method: 'PATCH',
        body: { enabled },
      }),
    onSuccess: (result) => {
      setError('')
      qc.setQueryData(['parent', 'email-notifications'], (prev: Prefs | undefined) => ({
        enabled: result.enabled,
        email: prev?.email ?? data?.email ?? '',
      }))
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not change that.'),
  })

  // Keep the stale error from a previous toggle from lingering once fresh
  // data arrives.
  useEffect(() => {
    if (data) setError('')
  }, [data])

  if (!data) return null

  const on = data.enabled

  return (
    <Card className="mb-4 p-4">
      <div className="flex items-center gap-3">
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
            on ? 'bg-leaf-50 text-leaf-500' : 'bg-canvas-100 text-ink-400'
          }`}
        >
          {on ? (
            <Mail className="size-5" strokeWidth={2.1} />
          ) : (
            <MailX className="size-5" strokeWidth={2.1} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-ink-900">
            {on ? 'Email notifications are on' : 'Turn on email notifications'}
          </p>
          <p className="text-[0.85rem] font-medium text-ink-500">
            {on
              ? `Sent to ${data.email}, alongside anything you get by push.`
              : "Get the same alerts by email — handy if push doesn't reach you."}
          </p>
        </div>
        <Button
          size="sm"
          variant={on ? 'outline' : 'primary'}
          loading={set.isPending}
          onClick={() => set.mutate(!on)}
        >
          {on ? 'Turn off' : 'Turn on'}
        </Button>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
          {error}
        </p>
      )}
    </Card>
  )
}
