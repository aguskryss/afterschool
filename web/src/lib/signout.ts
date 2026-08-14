/**
 * Signing out, in one place.
 *
 * The counselor rail put a Sign out button next to the name on a shared cart
 * tablet, which is the second caller of what used to be a private function
 * inside Account.tsx. Copying those four lines would have been the cheap move
 * and the wrong one: the push unsubscribe is the part that is easy to leave
 * out, and leaving it out is silent — the next person to sign in on that
 * device keeps receiving the previous counselor's alerts, and nothing on
 * either screen ever says so.
 */
import { clearSession } from '@/lib/auth'
import { disablePush } from '@/lib/push'

export async function signOut(): Promise<void> {
  // Never let a failed unsubscribe strand someone signed in on a shared
  // device: the sign-out itself must happen either way.
  await disablePush().catch(() => {})
  clearSession()
  // A full reload rather than a client navigation, so every cached query and
  // the open SSE connection are torn down with the session.
  window.location.href = '/app/login'
}
