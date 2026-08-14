import { useEffect, useState } from 'react'
import { Bell, BellOff } from 'lucide-react'
import {
  disablePush,
  enablePush,
  getPushState,
  sendTestPush,
  type PushState,
} from '@/lib/push'
import { Button, Card } from '@/components/ui'

const COPY: Record<PushState, { title: string; body: string }> = {
  on: {
    title: 'Notifications are on',
    body: 'This device will be alerted even when the app is closed.',
  },
  off: {
    title: 'Turn on notifications',
    body: 'Get alerted the moment something needs you, without keeping the app open.',
  },
  denied: {
    title: 'Notifications are blocked',
    body: 'Your browser is refusing them. Allow notifications for this site in your browser settings, then reload.',
  },
  unsupported: {
    title: 'Notifications not available',
    body: "This browser can't deliver them. On iPhone, add the app to your home screen first.",
  },
  unavailable: {
    title: 'Notifications are off for your program',
    body: 'An administrator can enable them.',
  },
}

/**
 * Push is the difference between an alert reaching a phone and an alert
 * landing on a screen nobody is looking at. It lives on the account screen so
 * the browser prompt only ever appears after a deliberate tap — asked for on
 * load it gets denied, and a denial is close to permanent.
 */
export function PushCard() {
  const [state, setState] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')

  useEffect(() => {
    void getPushState().then(setState)
  }, [])

  if (state === null) return null
  if (state === 'unavailable') return null

  const copy = COPY[state]
  const canAct = state === 'on' || state === 'off'

  async function toggle() {
    setBusy(true)
    setNote('')
    try {
      setState(state === 'on' ? await disablePush() : await enablePush())
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not change that.')
    } finally {
      setBusy(false)
    }
  }

  async function test() {
    setBusy(true)
    setNote('')
    try {
      setNote(await sendTestPush())
    } catch (e) {
      setNote(e instanceof Error ? e.message : 'Could not send a test.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card className="mb-4 p-4">
      <div className="flex items-center gap-3">
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${
            state === 'on'
              ? 'bg-leaf-50 text-leaf-500'
              : state === 'denied'
                ? 'bg-berry-50 text-berry-500'
                : 'bg-canvas-100 text-ink-400'
          }`}
        >
          {state === 'on' ? (
            <Bell className="size-5" strokeWidth={2.1} />
          ) : (
            <BellOff className="size-5" strokeWidth={2.1} />
          )}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-bold text-ink-900">{copy.title}</p>
          <p className="text-[0.85rem] font-medium text-ink-500">{copy.body}</p>
        </div>
        {canAct && (
          <Button
            size="sm"
            variant={state === 'on' ? 'outline' : 'primary'}
            loading={busy}
            onClick={toggle}
          >
            {state === 'on' ? 'Turn off' : 'Turn on'}
          </Button>
        )}
      </div>

      {state === 'on' && (
        <div className="mt-3 flex items-center gap-3 border-t border-canvas-200 pt-3">
          <Button size="sm" variant="ghost" loading={busy} onClick={test}>
            Send a test
          </Button>
          {note && (
            <span className="text-[0.85rem] font-semibold text-ink-500">
              {note}
            </span>
          )}
        </div>
      )}
      {state !== 'on' && note && (
        <p role="alert" className="mt-3 text-sm font-medium text-berry-600">
          {note}
        </p>
      )}
    </Card>
  )
}
