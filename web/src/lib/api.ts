import {
  clearSession,
  readSession,
  writeSession,
  type Organization,
  type Role,
} from './auth'

export class ApiError extends Error {
  status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

type Options = {
  method?: string
  body?: unknown
  /** Skip the Authorization header (login, forgot-password, reset). */
  anonymous?: boolean
}

async function raw(path: string, opts: Options = {}): Promise<Response> {
  // FormData sets its own Content-Type, and it has to: the header carries the
  // multipart boundary, which only the browser knows. Setting it by hand
  // produces a body the server can't parse.
  const isForm = opts.body instanceof FormData
  const headers: Record<string, string> = isForm
    ? {}
    : { 'Content-Type': 'application/json' }
  if (!opts.anonymous) {
    const session = readSession()
    if (session) headers.Authorization = `Bearer ${session.token}`
  }
  return fetch(path, {
    method: opts.method ?? 'GET',
    headers,
    body:
      opts.body === undefined
        ? undefined
        : isForm
          ? (opts.body as FormData)
          : JSON.stringify(opts.body),
  })
}

/** Swap an expired access token for a fresh one. Returns false if the refresh token is dead too. */
async function refresh(): Promise<boolean> {
  const session = readSession()
  if (!session?.refreshToken) return false
  const res = await fetch('/api/auth/refresh', {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.refreshToken}` },
  })
  if (!res.ok) return false
  const data = (await res.json()) as { token: string }
  writeSession({ ...session, token: data.token })
  return true
}

/**
 * One 401 triggers one refresh and one retry. If that still fails the session
 * is genuinely gone, so we clear it and let the router bounce to /app/login.
 */
export async function api<T>(path: string, opts: Options = {}): Promise<T> {
  let res = await raw(path, opts)

  if (res.status === 401 && !opts.anonymous) {
    if (await refresh()) {
      res = await raw(path, opts)
    } else {
      clearSession()
      throw new ApiError(401, 'Your session expired. Please sign in again.')
    }
  }

  if (!res.ok) {
    let message = `Request failed (${res.status})`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new ApiError(res.status, message)
  }

  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

/**
 * Fetch a file the server generates and hand it to the browser's downloader.
 *
 * Exports are spreadsheets behind `@jwt_required`, so a plain link can't reach
 * them — the browser sends no Authorization header on a navigation. This goes
 * through the same 401-refresh-retry path as every other call, then turns the
 * response into a download.
 *
 * The filename comes from Content-Disposition when the server sets one, so the
 * name stays the server's business rather than being guessed in two places.
 */
export async function download(path: string, fallbackName: string): Promise<void> {
  let res = await raw(path)

  if (res.status === 401) {
    if (await refresh()) {
      res = await raw(path)
    } else {
      clearSession()
      throw new ApiError(401, 'Your session expired. Please sign in again.')
    }
  }

  if (!res.ok) {
    let message = `Export failed (${res.status})`
    try {
      const data = (await res.json()) as { error?: string }
      if (data.error) message = data.error
    } catch {
      /* the error body wasn't JSON — keep the generic message */
    }
    throw new ApiError(res.status, message)
  }

  const disposition = res.headers.get('Content-Disposition') || ''
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)
  const name = match ? decodeURIComponent(match[1]) : fallbackName

  const url = URL.createObjectURL(await res.blob())
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoking immediately can cancel the download in Safari; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export type LoginResult =
  | {
      kind: 'ok'
      token: string
      refresh_token: string
      role: Role
      name: string
      organization: Organization | null
    }
  | { kind: 'needs2fa' }

/**
 * The backend answers a 2FA-enabled account with 200 + {requires_2fa:true}
 * rather than an error, so that case is a normal outcome, not a throw.
 */
export async function login(
  email: string,
  password: string,
  totpCode?: string,
): Promise<LoginResult> {
  const data = await api<{
    requires_2fa?: boolean
    token?: string
    refresh_token?: string
    role?: Role
    name?: string
    organization?: Organization | null
  }>('/api/auth/login', {
    method: 'POST',
    anonymous: true,
    body: { email, password, ...(totpCode ? { totp_code: totpCode } : {}) },
  })

  if (data.requires_2fa) return { kind: 'needs2fa' }

  return {
    kind: 'ok',
    token: data.token!,
    refresh_token: data.refresh_token!,
    role: data.role!,
    name: data.name!,
    organization: data.organization ?? null,
  }
}

/**
 * Re-read branding and modules for the current session.
 *
 * A superadmin can change them while someone is signed in; without this the
 * only way to pick the change up would be to sign out and back in.
 */
export async function refreshContext(): Promise<Organization | null> {
  const session = readSession()
  if (!session) return null
  const data = await api<{ organization: Organization | null }>('/api/auth/context')
  writeSession({ ...session, organization: data.organization })
  return data.organization
}
