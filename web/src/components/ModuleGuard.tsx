import type { ReactNode } from 'react'
import { Lock, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { hasModule, type ModuleKey } from '@/lib/auth'
import { Card, EmptyState } from '@/components/ui'

/**
 * Refuses a screen whose endpoints belong to a module the organization has not
 * bought.
 *
 * Hiding the nav item is not enough: the route still exists, so a bookmark, a
 * back button or a pasted URL lands on a screen whose every request comes back
 * 403. React Query then leaves `data` undefined and the screen shows its empty
 * state — "No make-up classes booked" — which is a lie. The JCC has not got the
 * feature, not an empty list of it.
 *
 * The handoff records this exact mistake appearing four times in one session.
 * It is cheaper to make it structural than to remember it.
 *
 * `unless` is the same test inverted, and it exists for exactly one screen:
 * the legacy `/upload` importer. That one is *core* — every other JCC uses it,
 * so `/api/admin/upload-roster` is deliberately absent from `MODULE_ROUTES`
 * and the server will not refuse it. The nav already hides it wherever
 * `daily_ops` is on (`AdminShell`, same `unless` key), but hiding is not
 * guarding: a bookmark still reaches a screen that runs
 * `UPDATE children SET active = 0` over the whole program and reactivates only
 * the rows the uploaded file happens to contain. A truncated file withdraws
 * the JCC. This is the only thing standing in front of that.
 */
export function ModuleGuard({
  module,
  unless,
  children,
}: {
  module?: ModuleKey
  unless?: ModuleKey
  children: ReactNode
}) {
  if (unless && hasModule(unless)) {
    return (
      <div className="mx-auto w-full max-w-2xl">
        <Card>
          <EmptyState
            icon={<Lock className="size-7" strokeWidth={1.8} />}
            title="Use the roster importer"
            body="Your organization imports its roster through the reviewed importer, which shows you every change before anything is written. This older screen replaces the roster outright and withdraws any child the file leaves out."
            action={
              <Link
                to="/roster-import"
                className="inline-flex items-center gap-2 rounded-xl bg-ink-800 px-4 py-2 text-sm font-bold text-white"
              >
                Go to Import roster
                <ArrowRight className="size-4" strokeWidth={2.2} />
              </Link>
            }
          />
        </Card>
      </div>
    )
  }

  if (!module || hasModule(module)) return <>{children}</>

  return (
    <div className="mx-auto w-full max-w-2xl">
      <Card>
        <EmptyState
          icon={<Lock className="size-7" strokeWidth={1.8} />}
          title="Not part of your plan"
          body="This feature isn't enabled for your organization. Ask your program administrator if you'd like it turned on."
        />
      </Card>
    </div>
  )
}
