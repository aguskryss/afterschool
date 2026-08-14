import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { TriangleAlert } from 'lucide-react'
import { ApiError, api } from '@/lib/api'
import { Button, Card, Field } from '@/components/ui'

/**
 * The two operations that destroy data on purpose.
 *
 * Both were only in the legacy portal, and both are guarded server-side by an
 * exact confirmation phrase — the wipe additionally re-checks the admin's
 * password. This screen does not soften any of that: the phrase is typed, not
 * clicked, and the button stays dead until it matches. The point of a phrase is
 * that muscle memory can't produce it.
 *
 * They are deliberately together, on a screen nothing links to by accident, and
 * deliberately last in the nav.
 */
function DangerAction({
  title,
  body,
  phrase,
  buttonLabel,
  needsPassword,
  run,
}: {
  title: string
  body: string
  phrase: string
  buttonLabel: string
  needsPassword?: boolean
  run: (args: { confirm: string; password: string }) => Promise<unknown>
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [done, setDone] = useState('')

  const act = useMutation({
    mutationFn: () => run({ confirm, password }),
    onSuccess: (res) => {
      const summary =
        res && typeof res === 'object' && 'message' in res
          ? String((res as { message: unknown }).message)
          : 'Done.'
      setDone(summary)
      setOpen(false)
      setConfirm('')
      setPassword('')
      setError('')
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That did not go through.'),
  })

  const ready = confirm === phrase && (!needsPassword || password.length > 0)

  return (
    <Card className="mb-4 p-5">
      <div className="flex gap-3">
        <TriangleAlert className="size-5 shrink-0 text-coral-700" strokeWidth={2.1} />
        <div className="min-w-0 flex-1">
          <p className="font-extrabold text-ink-900">{title}</p>
          <p className="mt-1 text-[0.9rem] font-medium text-ink-600">{body}</p>
        </div>
        {!open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            {buttonLabel}
          </Button>
        )}
      </div>

      {done && (
        <p className="mt-3 text-[0.9rem] font-semibold text-ink-700">{done}</p>
      )}

      {open && (
        <div className="mt-4 flex flex-col gap-3 border-t border-canvas-200 pt-4">
          <Field
            label={`Type ${phrase} to confirm`}
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {needsPassword && (
            <Field
              label="Your password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          {error && (
            <p className="text-[0.9rem] font-semibold text-berry-600">{error}</p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setOpen(false)
                setConfirm('')
                setPassword('')
                setError('')
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={!ready}
              loading={act.isPending}
              onClick={() => act.mutate()}
            >
              {buttonLabel}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

export function AdminMaintenance() {
  return (
    <div className="mx-auto w-full max-w-2xl">
      <h1 className="mb-2 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Maintenance
      </h1>
      <p className="mb-6 text-[0.95rem] font-medium text-ink-500">
        Both of these delete data and neither can be undone. Export anything you
        want to keep first.
      </p>

      <DangerAction
        title="End of year"
        body="Removes every child, registration, absence and attendance record. Parent and counselor accounts, schools and the calendar stay, so next year starts from a fresh roster upload rather than a fresh install."
        phrase="END OF YEAR"
        buttonLabel="Run end of year"
        run={({ confirm }) =>
          api('/api/admin/end-of-year', { method: 'POST', body: { confirm } })
        }
      />

      <DangerAction
        title="Wipe all data"
        body="Empties the program completely. This is for starting over, not for cleaning up — if you are between school years you want End of year instead."
        phrase="WIPE ALL DATA"
        buttonLabel="Wipe everything"
        needsPassword
        run={({ confirm, password }) =>
          api('/api/admin/wipe-all-data', {
            method: 'POST',
            body: { confirm, password },
          })
        }
      />
    </div>
  )
}
