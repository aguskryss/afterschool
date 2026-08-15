import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { School, TriangleAlert, UserRound } from 'lucide-react'
import { api } from '@/lib/api'
import { readSession } from '@/lib/auth'
import { STATUS_LABEL, STATUS_TONE, type ChildStatus } from '@/lib/attendance'
import { Card, EmptyState, Pill, Skeleton } from '@/components/ui'

type Counselor = { id: number; name: string; permanent: boolean }

type Flag = {
  child_id: number
  name: string
  status: ChildStatus
  note: string | null
  at: string | null
  reported_by: string | null
}

type SchoolRow = {
  school_id: number
  school: string
  counselors: Counselor[]
  expected: number
  in_building: number
  checked_out: number
  problems: number
  waiting: number
  absent: number
  unscheduled: number
  flagged: Flag[]
}

type Board = {
  date: string
  /** Nobody has any assignment, so everyone covers everything. */
  every_counselor_covers_every_school: boolean
  schools: SchoolRow[]
}

/**
 * Re-fetch whenever anything moves.
 *
 * The board rides the headcount stream rather than opening a fourth SSE
 * endpoint: every attendance tap, status change and release already publishes
 * on it. The event is used as a signal, not as data — a NOTIFY payload is
 * capped at 8000 bytes and this board carries children's names, so putting
 * the whole thing on the wire would start silently degrading to a resync on
 * exactly the busy afternoon it exists for.
 */
function useBoardStream(onChange: () => void) {
  useEffect(() => {
    const session = readSession()
    if (!session) return
    const source = new EventSource(
      `/api/attendance/stream?token=${encodeURIComponent(session.token)}`,
    )
    source.addEventListener('headcount', onChange)
    return () => source.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'leaf' | 'coral' | 'ink'
}) {
  const colour =
    value === 0
      ? 'text-ink-300'
      : tone === 'leaf'
        ? 'text-leaf-600'
        : tone === 'coral'
          ? 'text-coral-600'
          : 'text-ink-900'
  return (
    <div className="min-w-16">
      <p className={`text-[1.5rem] leading-none font-extrabold ${colour}`}>
        {value}
      </p>
      <p className="mt-1 text-[0.72rem] font-bold tracking-wide text-ink-400 uppercase">
        {label}
      </p>
    </div>
  )
}

export function AdminLiveBoard() {
  const qc = useQueryClient()
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'operations'],
    queryFn: () => api<Board>('/api/admin/operations'),
  })
  useBoardStream(() =>
    void qc.invalidateQueries({ queryKey: ['admin', 'operations'] }),
  )

  const schools = data?.schools ?? []
  const totals = schools.reduce(
    (a, s) => ({
      expected: a.expected + s.expected,
      in_building: a.in_building + s.in_building,
      waiting: a.waiting + s.waiting,
      problems: a.problems + s.problems,
    }),
    { expected: 0, in_building: 0, waiting: 0, problems: 0 },
  )
  // Everything that needs a person, across every school, at the top — this is
  // the reason the board exists and it must not be something you scroll for.
  const allFlags = schools.flatMap((s) =>
    s.flagged.map((f) => ({ ...f, school: s.school })),
  )

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Live board
      </h1>
      <p className="mb-6 text-[0.95rem] font-medium text-ink-500">
        {isPending
          ? 'Loading the afternoon…'
          : `${totals.in_building} of ${totals.expected} in the building · ${totals.waiting} still out`}
      </p>

      {isPending ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          {allFlags.length > 0 && (
            <Card className="mb-6 overflow-hidden border-l-4 border-coral-500">
              <div className="bg-coral-50 px-5 py-3">
                <p className="font-extrabold text-coral-700">
                  {allFlags.length === 1
                    ? '1 child needs attention'
                    : `${allFlags.length} children need attention`}
                </p>
              </div>
              <ul className="divide-y divide-canvas-200">
                {allFlags.map((f) => (
                  <li
                    key={f.child_id}
                    className="flex flex-wrap items-center gap-x-3 gap-y-1 px-5 py-3"
                  >
                    <span className="font-bold text-ink-900">{f.name}</span>
                    <Pill status={STATUS_TONE[f.status]}>
                      {STATUS_LABEL[f.status]}
                    </Pill>
                    <span className="text-[0.85rem] font-semibold text-ink-500">
                      {f.school}
                    </span>
                    {f.note && (
                      <span className="flex items-center gap-1 text-[0.85rem] font-medium text-ink-600">
                        <TriangleAlert className="size-3.5" strokeWidth={2.4} />
                        {f.note}
                      </span>
                    )}
                    {f.reported_by && (
                      <span className="ms-auto text-[0.8rem] font-semibold text-ink-400">
                        {f.reported_by}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {schools.length === 0 ? (
            <Card>
              <EmptyState
                icon={<School className="size-7" strokeWidth={1.8} />}
                title="Nothing scheduled"
                body="No school has children enrolled for today."
              />
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              {schools.map((s) => (
                <Card key={s.school_id} className="overflow-hidden">
                  <div className="flex items-start gap-3 border-b border-canvas-200 px-5 py-3.5">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-500">
                      <School className="size-5" strokeWidth={2.1} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-extrabold text-ink-900">
                        {s.school}
                      </p>
                      <p className="flex flex-wrap items-center gap-1.5 text-[0.82rem] font-semibold text-ink-500">
                        <UserRound className="size-3.5" strokeWidth={2.4} />
                        {s.counselors.length > 0 ? (
                          s.counselors.map((c) => (
                            <span
                              key={c.id}
                              className={c.permanent ? '' : 'text-leaf-600'}
                              title={c.permanent ? 'Permanent' : 'Covering today'}
                            >
                              {c.name}
                            </span>
                          ))
                        ) : data?.every_counselor_covers_every_school ? (
                          // Not "unstaffed": with no assignments anywhere,
                          // every counselor covers every school by design.
                          <span>Every counselor</span>
                        ) : (
                          <span className="text-sun-600">Nobody assigned</span>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="flex flex-wrap gap-x-6 gap-y-3 px-5 py-4">
                    <Stat label="Expected" value={s.expected} />
                    <Stat label="In building" value={s.in_building} tone="leaf" />
                    <Stat label="Still out" value={s.waiting} />
                    <Stat label="Picked up" value={s.checked_out} />
                    <Stat label="Problems" value={s.problems} tone="coral" />
                    <Stat label="Absent" value={s.absent} />
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
