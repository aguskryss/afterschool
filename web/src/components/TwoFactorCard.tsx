import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { ShieldCheck } from 'lucide-react'
import { ApiError, api } from '@/lib/api'
import { Button, Card, Field, Pill } from '@/components/ui'

type Status = { enabled: boolean; available: boolean }
type Setup = { secret: string; provisioning_uri: string }

/**
 * Two-factor authentication, set up here rather than in the legacy portal.
 *
 * Three server calls, and the order matters: `setup` stores a secret with
 * `enabled = 0`, and only `verify` flips it on. So a user who starts the flow
 * and closes the tab is left exactly where they began — the secret is dead
 * weight until a valid code proves the authenticator actually holds it.
 *
 * The QR is rendered as SVG rather than a canvas or a data: URI so it inherits
 * the page's `img-src 'self' data:` CSP without needing an exception.
 */
export function TwoFactorCard() {
  const qc = useQueryClient()
  const [step, setStep] = useState<'idle' | 'scan' | 'disable'>('idle')
  const [setup, setSetup] = useState<Setup | null>(null)
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  const { data } = useQuery({
    queryKey: ['auth', '2fa', 'status'],
    queryFn: () => api<Status>('/api/auth/2fa/status'),
  })

  function reset() {
    setStep('idle')
    setSetup(null)
    setCode('')
    setPassword('')
    setError('')
  }

  const fail = (err: unknown, fallback: string) =>
    setError(err instanceof ApiError ? err.message : fallback)

  const begin = useMutation({
    mutationFn: () => api<Setup>('/api/auth/2fa/setup', { method: 'POST' }),
    onSuccess: (d) => {
      setSetup(d)
      setStep('scan')
      setError('')
    },
    onError: (e) => fail(e, 'Could not start setup.'),
  })

  const verify = useMutation({
    mutationFn: () =>
      api('/api/auth/2fa/verify', { method: 'POST', body: { code: code.trim() } }),
    onSuccess: () => {
      reset()
      void qc.invalidateQueries({ queryKey: ['auth', '2fa', 'status'] })
    },
    onError: (e) => fail(e, 'That code was not accepted.'),
  })

  const turnOff = useMutation({
    mutationFn: () =>
      api('/api/auth/2fa/disable', { method: 'POST', body: { password } }),
    onSuccess: () => {
      reset()
      void qc.invalidateQueries({ queryKey: ['auth', '2fa', 'status'] })
    },
    onError: (e) => fail(e, 'Could not turn it off.'),
  })

  // The server builds TOTP with pyotp; without it the endpoints return 500.
  // Offering a button that cannot work is worse than saying so.
  if (data && !data.available) {
    return (
      <Card className="mb-4 p-4">
        <p className="font-bold text-ink-900">Two-factor authentication</p>
        <p className="text-[0.85rem] font-medium text-ink-500">
          Not available on this server.
        </p>
      </Card>
    )
  }

  const on = data?.enabled ?? false

  return (
    <Card className="mb-4 p-4">
      <div className="flex items-center gap-3">
        {/* Tone follows the actual state — a green shield next to "Off"
            reads as reassurance the account hasn't earned. */}
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
            on ? 'bg-leaf-50 text-leaf-500' : 'bg-canvas-100 text-ink-400'
          }`}
        >
          <ShieldCheck className="size-5" strokeWidth={2.1} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-ink-900">Two-factor authentication</p>
          <p className="text-[0.85rem] font-medium text-ink-500">
            {on
              ? 'On — a code is required at sign-in.'
              : 'Off — an app on your phone generates a code at sign-in.'}
          </p>
        </div>
        {on && <Pill status="leaf">On</Pill>}
      </div>

      {step === 'idle' && (
        <div className="mt-4 flex justify-end">
          {on ? (
            <Button size="sm" variant="outline" onClick={() => setStep('disable')}>
              Turn off
            </Button>
          ) : (
            <Button size="sm" loading={begin.isPending} onClick={() => begin.mutate()}>
              Set up
            </Button>
          )}
        </div>
      )}

      {step === 'scan' && setup && (
        <div className="mt-4 border-t border-canvas-200 pt-4">
          <p className="mb-3 text-[0.9rem] font-medium text-ink-600">
            Scan this with Google Authenticator, Authy or 1Password, then enter the
            six-digit code it shows.
          </p>
          <div className="mb-4 flex justify-center rounded-2xl bg-white p-4">
            <QRCodeSVG value={setup.provisioning_uri} size={168} level="M" />
          </div>
          <p className="mb-4 text-center text-[0.8rem] text-ink-500">
            Can't scan? Enter this key by hand:
            <br />
            <code className="mt-1 inline-block break-all font-mono text-[0.85rem] font-bold text-ink-800">
              {setup.secret}
            </code>
          </p>
          <Field
            label="Six-digit code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          {error && (
            <p className="mt-2 text-[0.85rem] font-semibold text-berry-600">{error}</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={reset}>
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={code.trim().length < 6}
              loading={verify.isPending}
              onClick={() => verify.mutate()}
            >
              Turn on
            </Button>
          </div>
        </div>
      )}

      {step === 'disable' && (
        <div className="mt-4 border-t border-canvas-200 pt-4">
          <p className="mb-3 text-[0.9rem] font-medium text-ink-600">
            Confirm your password to turn two-factor off.
          </p>
          <Field
            label="Current password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && (
            <p className="mt-2 text-[0.85rem] font-semibold text-berry-600">{error}</p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={reset}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="danger"
              disabled={!password}
              loading={turnOff.isPending}
              onClick={() => turnOff.mutate()}
            >
              Turn off
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}
