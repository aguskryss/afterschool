import type { ReactNode } from 'react'
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { homeFor, readSession, type Role } from '@/lib/auth'
import { AppShell } from '@/components/AppShell'
import { CounselorShell } from '@/components/CounselorShell'
import { AdminShell } from '@/components/AdminShell'
import { Login } from '@/routes/Login'
import { Account } from '@/routes/Account'
import { ParentHome } from '@/routes/parent/Home'
import { ParentCalendar } from '@/routes/parent/Calendar'
import { ParentInbox } from '@/routes/parent/Inbox'
import { ParentPhotos } from '@/routes/parent/Photos'
import { CounselorToday } from '@/routes/counselor/Today'
import { CounselorSchoolAttendance } from '@/routes/counselor/SchoolAttendance'
import { CounselorPickup } from '@/routes/counselor/Pickup'
import { CounselorRoster } from '@/routes/counselor/Roster'
import { CounselorSchedule } from '@/routes/counselor/Schedule'
import { CounselorMyDay } from '@/routes/counselor/MyDay'
import { CounselorPhotos } from '@/routes/counselor/Photos'
import { CounselorOffice } from '@/routes/counselor/Office'
import { AdminDashboard } from '@/routes/admin/Dashboard'
import { SuperadminOrganizations } from '@/routes/superadmin/Organizations'
import {
  AdminAdmins,
  AdminCounselors,
  AdminParents,
} from '@/routes/admin/People'
import { AdminChildProfile, AdminChildren } from '@/routes/admin/Children'
import {
  AdminAbsences,
  AdminAttendance,
  AdminGrades,
  AdminSchools,
  AdminTimeOff,
} from '@/routes/admin/Operations'
import { AdminCalendar, AdminMessages, AdminUpload } from '@/routes/admin/Program'
import { AdminConversations } from '@/routes/admin/Conversations'
import { AdminMakeupRequests } from '@/routes/admin/MakeupRequests'
import { AdminNotifications } from '@/routes/admin/Notifications'
import { AdminActivities, AdminActivitySchedules } from '@/routes/admin/Activities'
import { AdminMaintenance } from '@/routes/admin/Maintenance'
import { ModuleGuard } from '@/components/ModuleGuard'
import { AdminPhotos } from '@/routes/admin/Photos'
import { AdminPickupLog } from '@/routes/admin/PickupLog'
import { AdminRosterImport } from '@/routes/admin/RosterImport'
import { AdminRooms } from '@/routes/admin/Rooms'
import { AdminClasses } from '@/routes/admin/Classes'
import { AdminCareRules } from '@/routes/admin/CareRules'
import { AdminStaffSchedule } from '@/routes/admin/StaffSchedule'
import { AdminDailyBoard } from '@/routes/admin/DailyBoard'
import { AdminLiveBoard } from '@/routes/admin/LiveBoard'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

/**
 * Route guard. Server-side authorization is unchanged — every /api/* route
 * still checks the JWT role claim — this only keeps people off screens that
 * would just 403 at them.
 */
function Guard({ allow, children }: { allow: Role[]; children: ReactNode }) {
  const location = useLocation()
  const session = readSession()

  if (!session) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />
  }
  if (!allow.includes(session.role)) {
    return <Navigate to={homeFor(session.role)} replace />
  }
  return <>{children}</>
}

/**
 * One route tree, two frames.
 *
 * A parent gets the phone frame; a counselor gets the one that becomes a left
 * rail on a tablet. Choosing here rather than splitting the tree keeps `/account`
 * — shared by both roles — a single route: two `<Route path="/account">` under
 * two different shells would resolve to whichever was declared first, and the
 * other role would silently get the wrong frame.
 */
function RoleShell() {
  return readSession()?.role === 'counselor' ? <CounselorShell /> : <AppShell />
}

/** Entry point: bounce to the right home, or to login. */
function Landing() {
  const session = readSession()
  return <Navigate to={session ? homeFor(session.role) : '/login'} replace />
}

/** Admin screens share one guard and one shell. */
const ADMIN_ROUTES: [string, ReactNode][] = [
  ['/dashboard', <AdminDashboard />],
  ['/children', <AdminChildren />],
  ['/children/:id', <AdminChildProfile />],
  ['/parents', <AdminParents />],
  ['/counselors', <AdminCounselors />],
  ['/admins', <AdminAdmins />],
  ['/schools', <AdminSchools />],
  ['/grades', <AdminGrades />],
  // Screens whose endpoints belong to a module are wrapped: hiding the nav
  // item leaves the route reachable by URL, and every request behind it 403s.
  ['/calendar-admin', <ModuleGuard module="calendar"><AdminCalendar /></ModuleGuard>],
  ['/activities', <ModuleGuard module="activities"><AdminActivities /></ModuleGuard>],
  ['/activity-times', <ModuleGuard module="activities"><AdminActivitySchedules /></ModuleGuard>],
  ['/live-board', <ModuleGuard module="check_in_out"><AdminLiveBoard /></ModuleGuard>],
  ['/attendance', <AdminAttendance />],
  ['/pickup-log', <ModuleGuard module="secure_pickup"><AdminPickupLog /></ModuleGuard>],
  ['/absences', <ModuleGuard module="absences"><AdminAbsences /></ModuleGuard>],
  ['/makeup', <ModuleGuard module="makeup_classes"><AdminMakeupRequests /></ModuleGuard>],
  ['/timeoff', <ModuleGuard module="time_off"><AdminTimeOff /></ModuleGuard>],
  ['/messages', <ModuleGuard module="messages"><AdminMessages /></ModuleGuard>],
  ['/notifications', <AdminNotifications />],
  // Either module is enough: the screen now carries a Parents tab and a
  // Staff tab, and an organization can buy one conversation channel without
  // the other.
  ['/conversations', <ModuleGuard module={['parent_messaging', 'staff_messaging']}><AdminConversations /></ModuleGuard>],
  ['/photos-admin', <ModuleGuard module="photos"><AdminPhotos /></ModuleGuard>],
  // Inverted on purpose: this is the legacy destructive importer, and it is
  // core rather than gated, so the server will not refuse it. See ModuleGuard.
  ['/upload', <ModuleGuard unless="daily_ops"><AdminUpload /></ModuleGuard>],
  ['/roster-import', <ModuleGuard module="daily_ops"><AdminRosterImport /></ModuleGuard>],
  ['/rooms', <ModuleGuard module="daily_ops"><AdminRooms /></ModuleGuard>],
  ['/classes', <ModuleGuard module="daily_ops"><AdminClasses /></ModuleGuard>],
  ['/care-rooms', <ModuleGuard module="daily_ops"><AdminCareRules /></ModuleGuard>],
  ['/staff-schedule', <ModuleGuard module="daily_ops"><AdminStaffSchedule /></ModuleGuard>],
  ['/daily-board', <ModuleGuard module="daily_ops"><AdminDailyBoard /></ModuleGuard>],
  ['/maintenance', <AdminMaintenance />],
]

export default function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename="/app">
        <Routes>
          <Route path="/" element={<Landing />} />
          <Route path="/login" element={<Login />} />

          {/* Parent: phone frame. Counselor: rail on a tablet, bottom bar on a
              phone. Same routes, frame picked by role. */}
          <Route element={<RoleShell />}>
            <Route
              path="/home"
              element={
                <Guard allow={['parent']}>
                  <ParentHome />
                </Guard>
              }
            />
            <Route
              path="/calendar"
              element={
                <Guard allow={['parent']}>
                  <ParentCalendar />
                </Guard>
              }
            />
            <Route
              path="/inbox"
              element={
                <Guard allow={['parent']}>
                  <ParentInbox />
                </Guard>
              }
            />
            <Route
              path="/photos"
              element={
                <Guard allow={['parent']}>
                  <ParentPhotos />
                </Guard>
              }
            />
            <Route
              path="/gallery"
              element={
                <Guard allow={['counselor']}>
                  <CounselorPhotos />
                </Guard>
              }
            />
            {/* Gated: every endpoint behind it belongs to daily_ops, so a JCC
                without the module would get a screen of 403s. */}
            <Route
              path="/my-day"
              element={
                <Guard allow={['counselor']}>
                  <ModuleGuard module="daily_ops">
                    <CounselorMyDay />
                  </ModuleGuard>
                </Guard>
              }
            />
            <Route
              path="/today"
              element={
                <Guard allow={['counselor']}>
                  <CounselorToday />
                </Guard>
              }
            />
            {/* One school's attendance. Nested under /today so the phone's
                back button walks out of a school and into the day, which is
                what a counselor expects after finishing at a gate. */}
            <Route
              path="/today/:schoolId"
              element={
                <Guard allow={['counselor']}>
                  <CounselorSchoolAttendance />
                </Guard>
              }
            />
            {/* The other half of the old Today screen: handing children over
                at the door, which is what secure_pickup sells. */}
            <Route
              path="/pickup"
              element={
                <Guard allow={['counselor']}>
                  <ModuleGuard module="secure_pickup">
                    <CounselorPickup />
                  </ModuleGuard>
                </Guard>
              }
            />
            <Route
              path="/roster"
              element={
                <Guard allow={['counselor']}>
                  <CounselorRoster />
                </Guard>
              }
            />
            <Route
              path="/schedule"
              element={
                <Guard allow={['counselor']}>
                  <CounselorSchedule />
                </Guard>
              }
            />
            {/* Off the counselor's main nav (see CounselorShell) — this is
                "things about me", like /schedule, so it is linked from
                Account rather than given a rail destination of its own. */}
            <Route
              path="/office"
              element={
                <Guard allow={['counselor']}>
                  <ModuleGuard module="staff_messaging">
                    <CounselorOffice />
                  </ModuleGuard>
                </Guard>
              }
            />
            <Route
              path="/account"
              element={
                <Guard allow={['parent', 'counselor']}>
                  <Account />
                </Guard>
              }
            />
          </Route>

          {/* Admin: desktop-first shell with a persistent sidebar. */}
          <Route element={<AdminShell />}>
            {ADMIN_ROUTES.map(([path, element]) => (
              <Route
                key={path}
                path={path}
                element={<Guard allow={['admin']}>{element}</Guard>}
              />
            ))}
            <Route
              path="/admin-account"
              element={
                <Guard allow={['admin', 'superadmin']}>
                  <Account />
                </Guard>
              }
            />
            {/* Kikar's own console, above every organization. */}
            <Route
              path="/organizations"
              element={
                <Guard allow={['superadmin']}>
                  <SuperadminOrganizations />
                </Guard>
              }
            />
          </Route>

          <Route path="*" element={<Landing />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  )
}
