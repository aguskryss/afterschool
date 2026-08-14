import { useState, type ComponentType } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import {
  Baby,
  BookOpen,
  Building2,
  CalendarClock,
  CalendarDays,
  Camera,
  ChartNoAxesColumn,
  ClipboardCheck,
  ClipboardList,
  DoorOpen,
  FileSpreadsheet,
  GraduationCap,
  Layers,
  Mail,
  Menu,
  Radio,
  Clock,
  MessagesSquare,
  BellRing,
  TriangleAlert,
  Repeat2,
  School,
  Settings,
  Shield,
  ShieldCheck,
  Target,
  Upload,
  UserRound,
  Users,
  X,
} from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { hasModule, readSession, type ModuleKey } from '@/lib/auth'
import { OrgLogo } from './Brand'

type Item = {
  to: string
  label: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
  /** Hidden when the organization doesn't have this module enabled. */
  module?: ModuleKey
  /**
   * Hidden when the organization *does* have this module — for a screen that a
   * module replaces rather than adds to. The route stays reachable by URL; only
   * the nav entry goes, so nothing that is bookmarked breaks.
   */
  unless?: ModuleKey
}

/**
 * The old admin sidebar was fourteen flat items hidden behind a hamburger —
 * on a 1600px desktop, where an administrator does all of this work. Grouping
 * turns a list you scan into a structure you learn, and on desktop it simply
 * stays open.
 */
const GROUPS: { title: string; items: Item[] }[] = [
  {
    title: 'Overview',
    items: [{ to: '/dashboard', label: 'Dashboard', icon: ChartNoAxesColumn }],
  },
  {
    title: 'People',
    items: [
      // No module flag: every JCC has children, and this is the only screen
      // that lists them. Above Parents because it is the one people look for.
      { to: '/children', label: 'Children', icon: Baby },
      { to: '/parents', label: 'Parents', icon: Users },
      { to: '/counselors', label: 'Counselors', icon: ClipboardList },
      { to: '/admins', label: 'Admins', icon: Shield },
    ],
  },
  {
    title: 'Program',
    items: [
      { to: '/schools', label: 'Schools', icon: School },
      // Next to Schools because both are places, and because a JCC sets them up
      // once in the same sitting. Safe to gate the whole item: Schools above has
      // no module, so this group never renders an empty heading.
      { to: '/rooms', label: 'Rooms', icon: DoorOpen, module: 'daily_ops' },
      // Distinct from Activities below, which is the other JCCs' drop-off
      // roster. This is the JCCSN class catalogue the routing engine reads.
      { to: '/classes', label: 'Classes', icon: BookOpen, module: 'daily_ops' },
      // Reads the rooms above and is read by everything downstream, so it sits
      // between the two things it joins rather than off in its own group.
      { to: '/care-rooms', label: 'Care rooms', icon: Layers, module: 'daily_ops' },
      // The point of the three above: it reads the classes and the care rooms
      // and is what the counselor's own day is filtered out of.
      { to: '/staff-schedule', label: 'Staff schedule', icon: CalendarClock, module: 'daily_ops' },
      { to: '/calendar-admin', label: 'Calendar', icon: CalendarDays, module: 'calendar' },
      // The other JCCs' model, and unrelated to Classes above: a drop-off and
      // pickup roster loaded from its own spreadsheet, with Activity times
      // setting that importer's default hours. Nothing in the daily_ops chain
      // reads either one, so a JCCSN-style program has no use for them — but
      // that is what turning the module off is for, not an `unless` here. See
      // the handoff entry of 2026-08-05.
      { to: '/activities', label: 'Activities', icon: Target, module: 'activities' },
      { to: '/activity-times', label: 'Activity times', icon: Clock, module: 'activities' },
    ],
  },
  {
    title: 'Operations',
    items: [
      // The two attendance sheets, generated. First in Operations because it is
      // the screen the afternoon is actually run from.
      { to: '/daily-board', label: 'Daily board', icon: ClipboardCheck, module: 'daily_ops' },
      { to: '/live-board', label: 'Live board', icon: Radio, module: 'check_in_out' },
      { to: '/attendance', label: 'Attendance', icon: GraduationCap },
      { to: '/pickup-log', label: 'Pickup record', icon: ShieldCheck, module: 'secure_pickup' },
      { to: '/absences', label: 'Absences', icon: CalendarDays, module: 'absences' },
      { to: '/makeup', label: 'Make-up classes', icon: Repeat2, module: 'makeup_classes' },
      { to: '/photos-admin', label: 'Photos', icon: Camera, module: 'photos' },
      { to: '/timeoff', label: 'Day off requests', icon: UserRound, module: 'time_off' },
    ],
  },
  {
    title: 'Communications',
    items: [
      { to: '/messages', label: 'Broadcast', icon: Mail, module: 'messages' },
      {
        to: '/conversations',
        label: 'Conversations',
        icon: MessagesSquare,
        module: 'parent_messaging',
      },
      // No module of its own: these switches govern events from several
      // modules at once, and a JCC with broadcasts off still notifies about
      // pickups.
      { to: '/notifications', label: 'Notifications', icon: BellRing },
    ],
  },
  {
    title: 'Data',
    items: [
      { to: '/roster-import', label: 'Import roster', icon: FileSpreadsheet, module: 'daily_ops' },
      // Hidden wherever the importer above exists. This one *replaces* the
      // roster and deactivates every child the file omits; that one is
      // additive and shows its work first. Two near-identical buttons, one of
      // them destructive, is an accident waiting for a tired Monday.
      { to: '/upload', label: 'Upload roster', icon: Upload, unless: 'daily_ops' },
      { to: '/maintenance', label: 'Maintenance', icon: TriangleAlert },
    ],
  },
]

const SUPER_GROUPS: { title: string; items: Item[] }[] = [
  {
    title: 'Platform',
    items: [{ to: '/organizations', label: 'Organizations', icon: Building2 }],
  },
]

/**
 * How many make-up requests nobody has looked at yet.
 *
 * Parents book these themselves, so without a count on the nav an admin has no
 * reason to open the screen and a booking sits unstaffed until the day itself.
 * Opening the screen clears it — see AdminMakeupRequests.
 */
function MakeupBadge() {
  const { data } = useQuery({
    queryKey: ['admin', 'makeup-unseen'],
    queryFn: () => api<{ count: number }>('/api/admin/makeup-requests/unseen-count'),
    // The nav is always mounted, so this is the one poll in the app. A minute
    // is far below how fast a parent booking needs answering.
    refetchInterval: 60_000,
  })
  if (!data?.count) return null
  return (
    <span className="ml-auto rounded-full bg-coral-500 px-2 py-0.5 text-[0.7rem] font-extrabold text-white">
      {data.count}
    </span>
  )
}

/**
 * How many messages from families nobody has read yet.
 *
 * Same hole the make-up badge closes: without a count an admin only learns a
 * parent wrote in by opening the screen. Grape, not coral — coral belongs to
 * pickup, and grape is already the messaging colour on the thread itself.
 */
function ConversationsBadge() {
  const { data } = useQuery({
    queryKey: ['admin', 'conversations', 'unread'],
    queryFn: () =>
      api<{ count: number }>('/api/admin/conversations/unread-count'),
    // The nav renders this only for orgs that have the module, but the guard
    // is repeated here: an ungated call to a gated endpoint is a 403, and the
    // nav is mounted on every screen.
    enabled: hasModule('parent_messaging'),
    refetchInterval: 60_000,
  })
  if (!data?.count) return null
  return (
    <span className="ml-auto rounded-full bg-grape-500 px-2 py-0.5 text-[0.7rem] font-extrabold text-white">
      {data.count}
    </span>
  )
}

function NavList({ isSuper, onNavigate }: { isSuper?: boolean; onNavigate?: () => void }) {
  return (
    <nav aria-label="Admin sections" className="flex flex-col gap-6 px-3 py-4">
      {(isSuper ? SUPER_GROUPS : GROUPS).map((group) => (
        <div key={group.title}>
          <p className="mb-1.5 px-3 text-[0.68rem] font-extrabold tracking-[0.12em] text-ink-400 uppercase">
            {group.title}
          </p>
          <div className="flex flex-col gap-0.5">
            {group.items
              .filter(
                (item) =>
                  (!item.module || hasModule(item.module)) &&
                  (!item.unless || !hasModule(item.unless)),
              )
              .map(({ to, label, icon: Icon }) => (
              <NavLink
                key={to}
                to={to}
                onClick={onNavigate}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-xl px-3 py-2 text-[0.9rem] font-bold transition-colors ${
                    isActive
                      ? 'bg-sky-50 text-sky-700'
                      : 'text-ink-600 hover:bg-canvas-100'
                  }`
                }
              >
                <Icon className="size-[1.1rem] shrink-0" strokeWidth={2.1} />
                {label}
                {to === '/makeup' && <MakeupBadge />}
                {to === '/conversations' && <ConversationsBadge />}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
      <div className="border-t border-canvas-200 pt-4">
        {/* /account renders inside the mobile shell; admins get the same
            screen under the sidebar layout instead. */}
        <NavLink
          to="/admin-account"
          onClick={onNavigate}
          className={({ isActive }) =>
            `flex items-center gap-2.5 rounded-xl px-3 py-2 text-[0.9rem] font-bold transition-colors ${
              isActive ? 'bg-sky-50 text-sky-700' : 'text-ink-600 hover:bg-canvas-100'
            }`
          }
        >
          <Settings className="size-[1.1rem] shrink-0" strokeWidth={2.1} />
          Settings
        </NavLink>
      </div>
    </nav>
  )
}

export function AdminShell() {
  const session = readSession()
  const [drawer, setDrawer] = useState(false)
  // A superadmin administers the platform, not a program, so the JCC-level
  // sections would all be empty for them.
  const isSuper = session?.role === 'superadmin'

  return (
    <div className="min-h-dvh bg-canvas-50">
      {/* Persistent on desktop — this is a desktop tool. */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-64 overflow-y-auto border-r border-canvas-200 bg-white lg:block">
        <div className="flex h-14 items-center px-6">
          <OrgLogo org={session?.organization ?? null} />
        </div>
        <NavList isSuper={isSuper} />
      </aside>

      {/* The drawer exists only for narrow screens. */}
      {drawer && (
        <div className="fixed inset-0 z-30 lg:hidden">
          <button
            aria-label="Close menu"
            onClick={() => setDrawer(false)}
            className="absolute inset-0 bg-ink-900/40"
          />
          <div className="absolute inset-y-0 left-0 w-72 overflow-y-auto bg-white">
            <div className="flex h-14 items-center justify-between px-5">
              <OrgLogo org={session?.organization ?? null} />
              <button
                aria-label="Close menu"
                onClick={() => setDrawer(false)}
                className="flex size-9 items-center justify-center rounded-full text-ink-500 hover:bg-canvas-100"
              >
                <X className="size-5" strokeWidth={2.2} />
              </button>
            </div>
            <NavList isSuper={isSuper} onNavigate={() => setDrawer(false)} />
          </div>
        </div>
      )}

      <div className="lg:pl-64">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-3 border-b border-canvas-200 bg-canvas-50/90 px-5 backdrop-blur">
          <button
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
            className="flex size-9 items-center justify-center rounded-full text-ink-600 hover:bg-canvas-100 lg:hidden"
          >
            <Menu className="size-5" strokeWidth={2.2} />
          </button>
          <span className="lg:hidden">
            <OrgLogo org={session?.organization ?? null} />
          </span>
          <span className="ml-auto text-sm font-semibold text-ink-500">
            {session?.name}
          </span>
        </header>

        <main className="px-5 py-6 lg:px-8">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
