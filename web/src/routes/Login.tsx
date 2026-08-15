import { useEffect, useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, login } from '@/lib/api'
import { homeFor, writeSession } from '@/lib/auth'
import { applyBranding } from '@/lib/branding'
import { OrgLogo, Wordmark } from '@/components/Brand'
import { Button, Field } from '@/components/ui'

type PublicBranding = {
  name: string | null
  logo_url: string | null
  brand_primary: string | null
  brand_accent: string | null
}

/**
 * One door for everyone.
 *
 * The role comes back from /api/auth/login, so nobody has to know whether
 * they're a "parent" or a "counselor" before they can type their email —
 * which is what the three old portal pages demanded.
 */
export function Login() {
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [totp, setTotp] = useState('')
  const [needs2fa, setNeeds2fa] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [branding, setBranding] = useState<PublicBranding | null>(null)

  // The sign-in screen has no token yet, so it cannot know the organization
  // the way every other screen does — it asks the one public endpoint that
  // exists for exactly this. Silently falls back to the platform wordmark on
  // any failure (network error, empty database), same as OrgLogo does.
  useEffect(() => {
    api<PublicBranding>('/api/public/branding', { anonymous: true })
      .then((b) => {
        setBranding(b)
        if (b.name) document.title = b.name
      })
      .catch(() => {})
  }, [])

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const result = await login(email, password, needs2fa ? totp : undefined)
      if (result.kind === 'needs2fa') {
        setNeeds2fa(true)
        return
      }
      writeSession({
        token: result.token,
        refreshToken: result.refresh_token,
        name: result.name,
        role: result.role,
        organization: result.organization,
      })
      // Paint before navigating, so the first screen the user sees is already
      // in their organization's colours rather than flashing Kikar's.
      applyBranding(result.organization)
      navigate(homeFor(result.role), { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-canvas-50 px-5 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex flex-col items-center text-center">
          {branding?.logo_url ? (
            <OrgLogo org={{ name: branding.name ?? '', logo_url: branding.logo_url }} />
          ) : (
            // No logo yet, but the name is enough on its own — better than
            // the platform wordmark once there is a real organization to name.
            <span className="font-brand text-2xl font-light tracking-[0.1em] text-ink-900">
              {branding?.name ?? <Wordmark className="text-2xl" />}
            </span>
          )}
          <h1 className="mt-7 text-[1.6rem] font-extrabold leading-tight text-ink-900">
            Welcome back
          </h1>
          <p className="mt-1.5 text-[0.97rem] font-medium text-ink-500">
            {needs2fa
              ? 'One more step to keep your account safe.'
              : 'Sign in to see your afterschool day.'}
          </p>
        </div>

        <form onSubmit={onSubmit} noValidate>
          <div className="flex flex-col gap-4">
            {!needs2fa ? (
              <>
                <Field
                  label="Email"
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  autoFocus
                  required
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
                <Field
                  label="Password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </>
            ) : (
              <Field
                label="Verification code"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                required
                maxLength={6}
                placeholder="000000"
                hint="Enter the 6-digit code from your authenticator app."
                value={totp}
                onChange={(e) => setTotp(e.target.value.replace(/\D/g, ''))}
              />
            )}

            {error && (
              <p role="alert" className="text-sm font-medium text-stop-500">
                {error}
              </p>
            )}

            <Button type="submit" size="lg" full loading={busy} className="mt-1">
              {needs2fa ? 'Verify' : 'Sign in'}
            </Button>
          </div>
        </form>

        <div className="mt-6 text-center">
          <a
            href="/reset-password"
            className="text-sm font-semibold text-ink-600 underline-offset-4 hover:underline"
          >
            Forgot your password?
          </a>
        </div>
      </div>
    </main>
  )
}
