import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation } from '@tanstack/react-query'
import { CalendarDays, ChevronRight, KeyRound, LogOut } from 'lucide-react'
import { api } from '@/lib/api'
import { hasModule, readSession } from '@/lib/auth'
import { Avatar, Button, Card, Field, Pill } from '@/components/ui'
import { PushCard } from '@/components/PushCard'
import { EmailNotificationsCard } from '@/components/EmailNotificationsCard'
import { TwoFactorCard } from '@/components/TwoFactorCard'
import { signOut } from '@/lib/signout'

const ROLE_LABEL: Record<string, string> = {
  parent: 'Parent',
  counselor: 'Counselor',
  admin: 'Administrator',
}

/** Shared by every role — the settings are the same regardless of who you are. */
export function Account() {
  const session = readSession()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)
  const [showForm, setShowForm] = useState(false)

  // Asking for 2FA status when the organization doesn't have the module is a
  // 403, not an empty answer — the server refuses modules it hasn't been sold.
  const twoFactor = hasModule('two_factor')
  const change = useMutation({
    mutationFn: () =>
      api('/api/auth/change-password', {
        method: 'POST',
        body: { current_password: current, new_password: next },
      }),
    onSuccess: () => {
      setCurrent('')
      setNext('')
      setConfirm('')
      setError('')
      setDone(true)
      setShowForm(false)
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : 'Could not update password.'),
  })

  function submit() {
    setDone(false)
    if (next !== confirm) {
      setError('The new passwords do not match.')
      return
    }
    setError('')
    change.mutate()
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <h1 className="mb-4 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Account
      </h1>

      <Card className="mb-4 flex items-center gap-4 p-4">
        <Avatar name={session?.name ?? '?'} id={0} size="lg" />
        <div className="min-w-0">
          <p className="truncate text-[1.05rem] font-extrabold text-ink-900">
            {session?.name}
          </p>
          <p className="mt-1">
            <Pill status="neutral">
              {ROLE_LABEL[session?.role ?? ''] ?? session?.role}
            </Pill>
          </p>
        </div>
      </Card>

      {/* Schedule left the counselor's main navigation: asking for a day off
          and looking at another date are both about the counselor, not about
          today, so they belong with the rest of "things about me". It is linked
          from here rather than dropped — removing a tab must not orphan the
          screen behind it. */}
      {session?.role === 'counselor' &&
        (hasModule('time_off') || hasModule('activities')) && (
          <Link to="/schedule" className="mb-4 block">
            <Card className="flex items-center gap-3 p-4 active:bg-canvas-100">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-500">
                <CalendarDays className="size-5" strokeWidth={2.1} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-bold text-ink-900">My schedule</p>
                <p className="text-[0.85rem] font-medium text-ink-500">
                  Days off and activity drop-offs
                </p>
              </div>
              <ChevronRight className="size-5 shrink-0 text-ink-300" strokeWidth={2.4} />
            </Card>
          </Link>
        )}

      <PushCard />

      {session?.role === 'parent' && <EmailNotificationsCard />}

      {twoFactor && <TwoFactorCard />}

      <Card className="mb-4 p-4">
        <div className="flex items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-500">
            <KeyRound className="size-5" strokeWidth={2.1} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-bold text-ink-900">Password</p>
            <p className="text-[0.85rem] font-medium text-ink-500">
              {done ? 'Updated just now.' : 'Change your sign-in password.'}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setShowForm((v) => !v)}
          >
            {showForm ? 'Cancel' : 'Change'}
          </Button>
        </div>

        {showForm && (
          <div className="mt-4 flex flex-col gap-3 border-t border-canvas-200 pt-4">
            <Field
              label="Current password"
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
            />
            <Field
              label="New password"
              type="password"
              autoComplete="new-password"
              hint="At least 8 characters."
              value={next}
              onChange={(e) => setNext(e.target.value)}
            />
            <Field
              label="Confirm new password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
            {error && (
              <p role="alert" className="text-sm font-medium text-berry-600">
                {error}
              </p>
            )}
            <Button
              full
              disabled={!current || !next || !confirm}
              loading={change.isPending}
              onClick={submit}
            >
              Update password
            </Button>
          </div>
        )}
      </Card>

      <Button variant="outline" full onClick={signOut}>
        <LogOut className="size-4" strokeWidth={2.2} />
        Sign out
      </Button>
    </div>
  )
}
