import { api } from './api'
import { hasModule } from './auth'

/**
 * Web push registration.
 *
 * The point of this app is that a parent tapping "I'm here" reaches a
 * counselor's phone. Without a subscription the event only lands on a screen
 * someone happens to be looking at, which is not the same promise.
 *
 * Permission is never requested on load. A browser prompt that appears before
 * the user knows what it's for gets denied, and a denial is close to
 * permanent — the only way back is browser settings. It is asked for from an
 * explicit control instead.
 */

export type PushState =
  | 'unsupported' // no service worker or Push API
  | 'unavailable' // the organization has push switched off
  | 'denied' // the user refused, and only browser settings can undo it
  | 'off' // supported and allowed, not subscribed yet
  | 'on'

/** The server hands out the VAPID key base64url-encoded; the API wants bytes. */
function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}

function supported(): boolean {
  return (
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export async function getPushState(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  if (!hasModule('push')) return 'unavailable'
  if (Notification.permission === 'denied') return 'denied'
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  return sub ? 'on' : 'off'
}

/**
 * Ask for permission and register. Returns the resulting state so the caller
 * can explain a denial rather than silently doing nothing.
 */
export async function enablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  if (!hasModule('push')) return 'unavailable'

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return 'denied'

  const { public_key: key } = await api<{ public_key: string }>(
    '/api/push/vapid-public-key',
  )
  if (!key) {
    // The server has no VAPID keypair; subscribing would produce a
    // subscription nothing can ever send to.
    return 'unavailable'
  }

  const reg = await navigator.serviceWorker.ready
  const existing = await reg.pushManager.getSubscription()
  // Re-register even when a subscription exists: the server row may have been
  // dropped, and re-sending it is idempotent there.
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key) as BufferSource,
    }))

  await api('/api/push/subscribe', {
    method: 'POST',
    body: { subscription: sub.toJSON() },
  })
  return 'on'
}

export async function disablePush(): Promise<PushState> {
  if (!supported()) return 'unsupported'
  const reg = await navigator.serviceWorker.getRegistration()
  const sub = await reg?.pushManager.getSubscription()
  if (!sub) return 'off'
  // Tell the server first. If the order were reversed and this failed, the
  // server would keep pushing to an endpoint the browser has thrown away.
  await api('/api/push/unsubscribe', {
    method: 'POST',
    body: { endpoint: sub.endpoint },
  }).catch(() => {})
  await sub.unsubscribe()
  return 'off'
}

export async function sendTestPush(): Promise<string> {
  const res = await api<{ message: string }>('/api/push/test', { method: 'POST' })
  return res.message
}
