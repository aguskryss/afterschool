import { useEffect, useState } from 'react'
import { Bell, X } from 'lucide-react'
import { enablePush, getPushState, type PushState } from '@/lib/push'
import { Button, Card } from '@/components/ui'

/**
 * The nudge that asks for notifications where someone will actually see it.
 *
 * WHY THIS IS NOT AUTOMATIC, AND CANNOT BE.
 * Safari — and therefore every iPhone — only honours
 * Notification.requestPermission() when it is called from a user gesture. Fired
 * on mount it does not prompt; it resolves as denied without showing anything,
 * and a denial is close to permanent because the only way back is Settings.
 * Chrome allows an unprompted call and then punishes it: sites that ask on load
 * get the permission auto-blocked for repeat visitors.
 *
 * So the closest honest thing to "automatic" is this: put the ask in front of
 * the person at the moment it makes sense, and let one tap raise the real
 * dialog. The prompt appears by itself; the tap is what the platform requires.
 *
 * WHERE IT SHOWS
 * Only when it can actually work — `off` means supported, allowed by the
 * organization, and not yet subscribed. On an iPhone in Safari the Push API
 * does not exist at all, so the state is `unsupported` and this stays hidden:
 * there is nothing to grant until the app is on the home screen, and asking
 * before then would be a dead end. The Account screen carries that explanation.
 *
 * DISMISSAL IS REMEMBERED, AND THAT IS THE POINT
 * A banner that comes back every visit is how someone learns to tap the X
 * without reading, and then denies the permission to make it stop. It stays
 * away for a fortnight, and the Account screen is always there in between.
 */

const SNOOZE_KEY = 'kikar_push_prompt_snoozed_until'
const SNOOZE_DAYS = 14

function snoozed(): boolean {
  try {
    const until = Number(localStorage.getItem(SNOOZE_KEY) || 0)
    return Number.isFinite(until) && Date.now() < until
  } catch {
    return false
  }
}

function snooze(): void {
  try {
    localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + SNOOZE_DAYS * 86_400_000),
    )
  } catch {
    // Private mode with storage disabled. The banner reappearing is a worse
    // outcome than losing the preference, but not one worth an error for.
  }
}

export function PushPrompt() {
  const [state, setState] = useState<PushState | null>(null)
  const [hidden, setHidden] = useState(snoozed)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    void getPushState().then(setState)
  }, [])

  if (hidden || state !== 'off') return null

  async function turnOn() {
    setBusy(true)
    setFailed(false)
    try {
      const next = await enablePush()
      setState(next)
      // A refusal is permanent enough that re-asking is pointless; the card on
      // the Account screen explains how to undo it in browser settings.
      if (next !== 'on') setFailed(true)
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-4 border-2 border-sky-100 bg-sky-50 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-white text-sky-600">
          <Bell className="size-5" strokeWidth={2.1} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-extrabold text-ink-900">Turn on notifications</p>
          <p className="text-[0.85rem] font-medium text-ink-600">
            {failed
              ? 'Your browser refused. You can allow notifications for this site in its settings, then reload.'
              : "So you hear about pickup and messages without keeping the app open."}
          </p>
          {!failed && (
            <div className="mt-3 flex items-center gap-2">
              <Button size="sm" loading={busy} onClick={turnOn}>
                Turn on
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  snooze()
                  setHidden(true)
                }}
              >
                Not now
              </Button>
            </div>
          )}
        </div>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => {
            snooze()
            setHidden(true)
          }}
          className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-400 hover:bg-white/70"
        >
          <X className="size-4" strokeWidth={2.4} />
        </button>
      </div>
    </Card>
  )
}
