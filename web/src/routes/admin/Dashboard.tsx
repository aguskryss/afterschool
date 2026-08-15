import { useQuery } from '@tanstack/react-query'
import { ClipboardList, School, Users, UserRound } from 'lucide-react'
import { api } from '@/lib/api'
import { hasModule } from '@/lib/auth'
import { usePickupStream } from '@/lib/usePickupStream'
import { useHeadcountStream } from '@/lib/useHeadcountStream'
import { Avatar, Card, EmptyState, Pill, Skeleton } from '@/components/ui'
import { TrendCard } from '@/components/TrendCard'
import { PushPrompt } from '@/components/PushPrompt'

type Stats = {
  parents: number
  children: number
  /** Of those children, how many attend on at least one weekday. */
  children_enrolled: number
  counselors: number
  schools: number
}

type Status = 'connecting' | 'live' | 'offline'

const TILES = [
  {
    key: 'children',
    label: 'Children',
    icon: Users,
    tint: 'bg-sky-50 text-sky-500',
    // The gap between these two is the answer to "why does it say 156
    // children and 74 expected?" — the rest have no weekday enrolled yet.
    caption: (s: Stats) => `${s.children_enrolled} enrolled this week`,
  },
  { key: 'parents', label: 'Parents', icon: UserRound, tint: 'bg-grape-50 text-grape-500' },
  {
    key: 'counselors',
    label: 'Counselors',
    icon: ClipboardList,
    tint: 'bg-teal-50 text-teal-500',
  },
  { key: 'schools', label: 'Schools', icon: School, tint: 'bg-sun-50 text-sun-600' },
] as const

/** Shared connection dot — the same three states on every live card. */
function LiveDot({ status, label }: { status: Status; label: string }) {
  return (
    <p className="flex items-center gap-1.5 text-[0.82rem] font-semibold text-ink-500">
      <span
        className={`size-1.5 rounded-full ${
          status === 'live'
            ? 'bg-leaf-500'
            : status === 'offline'
              ? 'bg-berry-500'
              : 'bg-sun-500'
        }`}
      />
      {label} ·{' '}
      {status === 'live'
        ? 'Live'
        : status === 'offline'
          ? 'Reconnecting…'
          : 'Connecting…'}
    </p>
  )
}

/**
 * Who is in the building right now, per school.
 *
 * Its own component so the SSE connection is only opened for organizations
 * with the check_in_out module — mounting it unconditionally would leave every
 * other JCC's dashboard stuck on a 403 that reads as "Reconnecting…".
 */
function HeadcountCard() {
  const { schools, status } = useHeadcountStream(true)
  const present = schools.reduce((n, s) => n + s.present, 0)
  const expected = schools.reduce((n, s) => n + s.expected, 0)

  return (
    <Card className="mb-6 overflow-hidden">
      <div className="flex items-center gap-3 border-b border-canvas-200 px-5 py-3.5">
        <div className="min-w-0 flex-1">
          <p className="font-extrabold text-ink-900">
            {present} of {expected} in the building
          </p>
          <LiveDot status={status} label="Headcount" />
        </div>
      </div>

      {schools.length === 0 ? (
        <EmptyState
          title="Nothing scheduled"
          body="Once children are checked in, the count appears here in real time."
        />
      ) : (
        <ul className="divide-y divide-canvas-200">
          {schools.map((s) => (
            <li
              key={s.school_id}
              className="flex items-center gap-3 px-5 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-ink-900">{s.school}</p>
                <p className="text-[0.82rem] font-medium text-ink-500">
                  {/* A school with nobody enrolled today used to be dropped
                      from this list entirely, which read as "no such school"
                      rather than "not their day". */}
                  {s.expected === 0
                    ? 'Nobody scheduled today'
                    : [
                        s.released > 0 ? `${s.released} picked up` : null,
                        s.absent > 0 ? `${s.absent} absent` : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || 'Nobody picked up yet'}
                </p>
              </div>
              <p className="text-[1.15rem] font-extrabold text-ink-900">
                {s.present}
                <span className="text-[0.9rem] font-bold text-ink-400">
                  /{s.expected}
                </span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

/** The live pickup queue — only for organizations that run it. */
function PickupCard() {
  const { pickups, status } = usePickupStream()

  return (
    <Card className="overflow-hidden">
      <div
        className={`flex items-center gap-3 px-5 py-3.5 ${
          pickups.length ? 'bg-coral-50' : 'bg-canvas-100'
        }`}
      >
        <div className="min-w-0 flex-1">
          <p
            className={`font-extrabold ${pickups.length ? 'text-coral-700' : 'text-ink-700'}`}
          >
            {pickups.length ? `${pickups.length} waiting` : 'No one waiting'}
          </p>
          <LiveDot status={status} label="Pickup queue" />
        </div>
      </div>

      {pickups.length === 0 ? (
        <EmptyState
          title="All clear"
          body="Parents waiting at the curb appear here in real time."
        />
      ) : (
        <ul className="divide-y divide-canvas-200">
          {pickups.map((p) => (
            <li key={p.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={p.child_name} id={p.child_id} />
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold text-ink-900">
                  {p.child_name}
                </p>
                <p className="truncate text-[0.85rem] font-medium text-ink-500">
                  {p.parent_name}
                </p>
              </div>
              <Pill status="coral">Unclaimed</Pill>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

export function AdminDashboard() {
  const { data: stats, isPending } = useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: () => api<Stats>('/api/admin/stats'),
  })

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      {/* Admins are on the receiving end too: a parent's message and a make-up
          request both push to them. */}
      <PushPrompt />

      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Dashboard
      </h1>

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {TILES.map((tile) => {
          const { key, label, icon: Icon, tint } = tile
          const caption = 'caption' in tile && stats ? tile.caption(stats) : null
          return (
            <Card key={key} className="p-4">
              <span
                className={`mb-3 flex size-10 items-center justify-center rounded-xl ${tint}`}
              >
                <Icon className="size-5" strokeWidth={2.1} />
              </span>
              {isPending ? (
                <Skeleton className="h-8 w-12" />
              ) : (
                <p className="text-[1.9rem] leading-none font-extrabold text-ink-900">
                  {stats?.[key] ?? 0}
                </p>
              )}
              <p className="mt-1.5 text-[0.85rem] font-bold text-ink-500">
                {label}
              </p>
              {caption && (
                <p className="mt-0.5 text-[0.78rem] font-semibold text-ink-400">
                  {caption}
                </p>
              )}
            </Card>
          )
        })}
      </div>

      <TrendCard />

      {hasModule('check_in_out') && <HeadcountCard />}
      {hasModule('pickups') && <PickupCard />}
    </div>
  )
}
