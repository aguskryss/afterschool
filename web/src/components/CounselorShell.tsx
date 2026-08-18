import type { ComponentType } from 'react'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  CalendarClock,
  Camera,
  ChevronsLeft,
  ChevronsRight,
  House,
  LogOut,
  MessagesSquare,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { api } from '@/lib/api'
import { hasModule, readSession, type ModuleKey } from '@/lib/auth'
import { signOut } from '@/lib/signout'
import { OrgLogo } from './Brand'

/**
 * The counselor's frame, on whatever they are holding.
 *
 * WHY THIS IS NOT AppShell
 *   AppShell is a phone frame: a bottom tab bar, one column, `max-w-2xl`. That
 *   is right for a parent, who opens the app standing in a doorway. A counselor
 *   works from a tablet in landscape — propped on a cart, held in one arm — and
 *   there the bottom bar spends the scarcest dimension (vertical space) and
 *   puts navigation at the edge furthest from two hands holding the sides.
 *
 *   So the frame changes with the width rather than the role:
 *
 *     >= 1024px   rail with icon and label      landscape tablet, desktop
 *     768-1023px  rail collapsed to icons       portrait tablet
 *     < 768px     bottom tab bar                phone
 *
 *   The bottom bar is not a fallback anyone settled for. On a phone held in one
 *   hand it is the correct pattern, and a counselor photographing a class or
 *   releasing a child at the door really is on a phone. Both frames navigate
 *   the same four or five destinations, so nothing is reachable from one and
 *   not the other.
 *
 * WHY THE DESTINATIONS SHRANK
 *   Seven tabs, of which four (Today / My day / Roster / Schedule) read to a
 *   counselor as the same thing: the list of kids this afternoon. Roster is now
 *   `Children`, named for what it is — looking a child up — which is what it
 *   collided with the class roster inside My day over. Schedule is not a place
 *   at all (it is time-off requests and activity drop-offs, both about the
 *   counselor rather than about today), so it moves under Account, which is
 *   where the rest of "things about me" already lives.
 *
 *   Pickup stays a destination rather than folding into Today. A parent at the
 *   door is a workflow with a search field and a release action, not a queue to
 *   glance at — and it is the screen most likely to be used on a phone, where
 *   demoting it behind an Account tab would cost more than the tab saves.
 *
 * WHY THE NAME IS ALWAYS ON SCREEN
 *   These tablets live on carts and get shared. Whoever is signed in is who the
 *   sign-out sheet will be signed by, so the identity sits at the foot of the
 *   rail permanently, and Sign out sits under it — one tap, behind a confirm so
 *   a mis-tap in a gym does not log somebody out mid-dismissal.
 */

type Item = {
  to: string
  label: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  /** Hidden unless the organization has at least one of these enabled. */
  modules?: ModuleKey[]
}

const NAV: Item[] = [
  { to: '/today', label: 'Today', icon: House },
  { to: '/my-day', label: 'My day', icon: CalendarClock, modules: ['daily_ops'] },
  { to: '/pickup', label: 'Pickup', icon: ShieldCheck, modules: ['secure_pickup'] },
  // Was "Roster". Renamed for the job it does — find one child, read their
  // allergies and contacts — which is not the job of any list inside My day.
  { to: '/roster', label: 'Children', icon: Users },
  { to: '/gallery', label: 'Photos', icon: Camera, modules: ['photos'] },
  // Unlike Schedule (moved under Account, see the file doc above), this one
  // stays a destination: a reply from the office can land at any moment
  // during the shift, and the badge below is what makes that visible without
  // opening the tab on a hunch.
  { to: '/office', label: 'Messages', icon: MessagesSquare, modules: ['staff_messaging'] },
]

/**
 * How many office replies this counselor hasn't opened yet.
 *
 * Same reason AdminShell's ConversationsBadge exists: without a count on the
 * rail, a reply from the office only turns up if a counselor happens to open
 * Messages on a hunch. The nav is mounted for the whole session, so this is
 * the one poll on this shell.
 */
function MessagesBadge() {
  const { data } = useQuery({
    queryKey: ['counselor', 'conversation', 'unread'],
    queryFn: () => api<{ count: number }>('/api/counselor/conversation/unread-count'),
    enabled: hasModule('staff_messaging'),
    refetchInterval: 60_000,
  })
  if (!data?.count) return null
  return (
    <span className="absolute -top-1 -right-1.5 flex min-w-[1.05rem] items-center justify-center rounded-full bg-grape-500 px-1 text-[0.62rem] font-extrabold text-white">
      {data.count}
    </span>
  )
}

export function CounselorShell() {
  const session = readSession()
  const [collapsed, setCollapsed] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const items = NAV.filter((i) => !i.modules || i.modules.some(hasModule))

  return (
    <div className="min-h-dvh bg-canvas-50 md:flex">
      {/* ── Rail: tablet and up ─────────────────────────────────────── */}
      <nav
        aria-label="Main"
        className={`hidden shrink-0 flex-col border-e border-canvas-200 bg-white p-3 md:sticky md:top-0 md:flex md:h-dvh ${
          collapsed ? 'md:w-[5.25rem]' : 'md:w-[5.25rem] lg:w-52'
        }`}
      >
        <div className="mb-3 flex items-center justify-center px-1 py-2 lg:justify-start">
          <OrgLogo org={session?.organization ?? null} />
        </div>

        <ul className="flex flex-col gap-1">
          {items.map(({ to, label, icon: Icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                title={label}
                className={({ isActive }) =>
                  `flex min-h-14 items-center justify-center gap-3 rounded-2xl px-3 text-[0.95rem] font-bold transition-colors ${
                    collapsed ? '' : 'lg:justify-start'
                  } ${
                    isActive
                      ? 'bg-sky-50 text-sky-700'
                      : 'text-ink-600 active:bg-canvas-100'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span className="relative inline-flex shrink-0">
                      <Icon
                        className={`size-6 ${isActive ? 'text-sky-500' : ''}`}
                        strokeWidth={isActive ? 2.2 : 1.8}
                      />
                      {to === '/office' && <MessagesBadge />}
                    </span>
                    <span className={collapsed ? 'hidden' : 'hidden lg:inline'}>
                      {label}
                    </span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>

        <div className="mt-auto border-t border-canvas-200 pt-2">
          {/* Who is holding this tablet. On a shared cart it is the first thing
              that has to be true, so it is not behind a tap. */}
          <NavLink
            to="/account"
            className="flex min-h-14 items-center justify-center gap-2.5 rounded-2xl px-2 text-ink-700 active:bg-canvas-100 lg:justify-start"
            title={session?.name ?? 'Account'}
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[0.9rem] font-extrabold text-sky-700">
              {initials(session?.name)}
            </span>
            <span className={`min-w-0 ${collapsed ? 'hidden' : 'hidden lg:block'}`}>
              <span className="block truncate text-[0.92rem] font-extrabold text-ink-900">
                {session?.name}
              </span>
              <span className="block text-[0.78rem] font-semibold text-ink-400">
                Counselor
              </span>
            </span>
          </NavLink>

          {confirming ? (
            <div className="flex flex-col gap-1.5 px-1 pb-1">
              <p
                className={`text-center text-[0.78rem] font-bold text-ink-500 ${
                  collapsed ? 'hidden' : 'hidden lg:block'
                }`}
              >
                Sign out {session?.name?.split(' ')[0]}?
              </p>
              <button
                type="button"
                onClick={() => void signOut()}
                className="min-h-12 rounded-full bg-berry-500 px-3 text-[0.85rem] font-extrabold text-white"
              >
                Yes
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="min-h-12 rounded-full border-2 border-canvas-200 px-3 text-[0.85rem] font-bold text-ink-600"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirming(true)}
              title="Sign out"
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-full border-2 border-canvas-200 px-3 text-[0.85rem] font-bold text-ink-600 active:bg-canvas-100"
            >
              <LogOut className="size-4 shrink-0" strokeWidth={2.2} />
              <span className={collapsed ? 'hidden' : 'hidden lg:inline'}>
                Sign out
              </span>
            </button>
          )}

          {/* Only offered where there is a label to collapse. Below `lg` the
              rail is already icons, so the control would do nothing. */}
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="mt-1 hidden min-h-11 w-full items-center justify-center gap-2 rounded-xl text-[0.78rem] font-bold text-ink-400 lg:flex"
          >
            {collapsed ? (
              <ChevronsRight className="size-4" strokeWidth={2.4} />
            ) : (
              <>
                <ChevronsLeft className="size-4" strokeWidth={2.4} />
                Collapse
              </>
            )}
          </button>
        </div>
      </nav>

      {/* ── The screen ──────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Phone only: the rail carries the logo and the identity everywhere
            else, and repeating them would cost a phone the height it has
            least of. */}
        <header className="sticky top-0 z-10 border-b border-canvas-200 bg-canvas-50/85 backdrop-blur md:hidden">
          <div className="flex h-14 items-center justify-between px-4">
            <OrgLogo org={session?.organization ?? null} />
            <NavLink
              to="/account"
              className="flex items-center gap-2 rounded-full py-1.5 ps-3 pe-1.5 text-sm font-bold text-ink-600"
            >
              <span className="max-w-32 truncate">{session?.name}</span>
              <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sky-100 text-[0.75rem] font-extrabold text-sky-700">
                {initials(session?.name)}
              </span>
            </NavLink>
          </div>
        </header>

        <main className="min-w-0 flex-1 pb-24 md:pb-0">
          <Outlet />
        </main>
      </div>

      {/* ── Bottom bar: phone only ──────────────────────────────────── */}
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-10 border-t border-canvas-200 bg-white/95 backdrop-blur md:hidden"
      >
        <ul className="flex">
          {items.map(({ to, label, icon: Icon }) => (
            <li key={to} className="flex-1">
              <NavLink
                to={to}
                className={({ isActive }) =>
                  `flex flex-col items-center gap-1 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-[0.7rem] font-semibold transition-colors ${
                    isActive ? 'text-sky-600' : 'text-ink-400'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span className="relative inline-flex">
                      <Icon
                        className="size-[1.35rem]"
                        strokeWidth={isActive ? 2.2 : 1.7}
                      />
                      {to === '/office' && <MessagesBadge />}
                    </span>
                    {label}
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  )
}

function initials(name: string | undefined): string {
  return (name ?? '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}
