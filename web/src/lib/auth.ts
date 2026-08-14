/**
 * Unified auth.
 *
 * The old frontend kept three separate localStorage namespaces
 * (jclub_token_parent / _counselor / _admin) and each portal rejected users
 * whose role didn't match it — "This portal is for parents only."
 *
 * The backend never needed that: POST /api/auth/login takes an email and a
 * password and returns the role. So there is exactly one session here, and
 * the role decides where you land.
 */

export type Role = 'superadmin' | 'parent' | 'counselor' | 'admin'

/**
 * Modules a superadmin can switch off per organization.
 *
 * Mirrors MODULES in server/tenancy.py. The console renders its toggles from
 * the server's catalogue, not from this type — this exists so `hasModule`
 * calls are checked at compile time.
 */
export type ModuleKey =
  | 'pickups'
  | 'absences'
  | 'recurring_absences'
  | 'makeup_classes'
  | 'activities'
  | 'messages'
  | 'calendar'
  | 'time_off'
  | 'push'
  | 'two_factor'
  | 'secure_pickup'
  | 'check_in_out'
  | 'photos'
  | 'parent_messaging'
  | 'late_arrivals'
  | 'daily_ops'

export type Organization = {
  id: number
  slug: string
  name: string
  logo_url: string | null
  brand_primary: string | null
  brand_accent: string | null
  timezone: string
  status: 'active' | 'suspended'
  modules: Partial<Record<ModuleKey, boolean>>
}

export type Session = {
  token: string
  refreshToken: string
  name: string
  role: Role
  /** Null for a superadmin, who belongs to no organization. */
  organization: Organization | null
}

const KEY = 'kikar_auth'

export function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Session>
    if (!parsed.token || !parsed.role) return null
    return parsed as Session
  } catch {
    return null
  }
}

export function writeSession(session: Session): void {
  localStorage.setItem(KEY, JSON.stringify(session))
}

export function clearSession(): void {
  localStorage.removeItem(KEY)
}

/**
 * Where each role lands after signing in. Router-relative: the BrowserRouter
 * basename already supplies the /app prefix.
 */
export const HOME_FOR: Record<Role, string> = {
  parent: '/home',
  counselor: '/today',
  admin: '/dashboard',
  superadmin: '/organizations',
}

export function homeFor(role: Role): string {
  return HOME_FOR[role] ?? '/home'
}

/**
 * Whether a module is available to the signed-in organization.
 *
 * Unknown or absent means off. This gates *presentation* only — a hidden
 * screen is a courtesy, not a control, and the server still refuses the call.
 */
export function hasModule(key: ModuleKey): boolean {
  const session = readSession()
  if (!session) return false
  if (session.role === 'superadmin') return true
  return Boolean(session.organization?.modules?.[key])
}
