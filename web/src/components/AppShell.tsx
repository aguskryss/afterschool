import type { ComponentType } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import {
  CalendarClock,
  CalendarDays,
  Camera,
  House,
  Inbox,
  ShieldCheck,
  Users,
  UserRound,
} from 'lucide-react'
import { hasModule, readSession, type ModuleKey, type Role } from '@/lib/auth'
import { OrgLogo } from './Brand'

type Item = {
  to: string
  label: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  /** Hidden unless the organization has at least one of these enabled. */
  modules?: ModuleKey[]
}

const NAV: Record<Role, Item[]> = {
  parent: [
    { to: '/home', label: 'Home', icon: House },
    // The parent calendar is also where absences are reported, so it stays
    // available if either module is on.
    {
      to: '/calendar',
      label: 'Calendar',
      icon: CalendarDays,
      modules: ['calendar', 'absences'],
    },
    // Announcements and the office thread share one screen, so either module
    // is enough to make it worth reaching.
    {
      to: '/inbox',
      label: 'Inbox',
      icon: Inbox,
      modules: ['messages', 'parent_messaging'],
    },
    { to: '/photos', label: 'Photos', icon: Camera, modules: ['photos'] },
    { to: '/account', label: 'Account', icon: UserRound },
  ],
  counselor: [
    { to: '/today', label: 'Today', icon: House },
    // What replaces the highlighted printout. Next to Today because both answer
    // "what am I doing now", and Today keeps the school-gate half.
    { to: '/my-day', label: 'My day', icon: CalendarClock, modules: ['daily_ops'] },
    // Attendance is taken at a school gate; a release happens at the door,
    // hours later, one child at a time. They were one screen and were in each
    // other's way.
    { to: '/pickup', label: 'Pickup', icon: ShieldCheck, modules: ['secure_pickup'] },
    { to: '/roster', label: 'Roster', icon: Users },
    { to: '/gallery', label: 'Photos', icon: Camera, modules: ['photos'] },
    // Schedule holds both the activity drop-offs and the day-off requests, so
    // it stays reachable if either module is on.
    {
      to: '/schedule',
      label: 'Schedule',
      icon: CalendarDays,
      modules: ['time_off', 'activities'],
    },
    { to: '/account', label: 'Account', icon: UserRound },
  ],
  // Admin and superadmin get the persistent desktop sidebar instead.
  admin: [],
  superadmin: [],
}

export function AppShell() {
  const session = readSession()
  const items = (session ? NAV[session.role] : []).filter(
    (item) => !item.modules || item.modules.some(hasModule),
  )

  return (
    <div className="min-h-dvh bg-canvas-50">
      <header className="sticky top-0 z-10 border-b border-canvas-200 bg-canvas-50/85 backdrop-blur">
        <div className="mx-auto flex h-14 w-full max-w-2xl items-center justify-between px-5">
          <OrgLogo org={session?.organization ?? null} />
          <span className="text-sm font-medium text-ink-500">
            {session?.name}
          </span>
        </div>
      </header>

      <main className="pb-24">
        <Outlet />
      </main>

      {items.length > 0 && (
        <nav
          aria-label="Main"
          className="fixed inset-x-0 bottom-0 border-t border-canvas-200 bg-white/95 backdrop-blur"
        >
          <div className="mx-auto flex w-full max-w-2xl">
            {items.map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                className={({ isActive }) =>
                  `flex flex-1 flex-col items-center gap-1 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))] text-[0.7rem] font-semibold transition-colors ${
                    isActive ? 'text-sky-600' : 'text-ink-400'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon
                      className="size-[1.35rem]"
                      strokeWidth={isActive ? 2.2 : 1.7}
                    />
                    {label}
                  </>
                )}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  )
}
