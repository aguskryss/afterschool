import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { Card, Skeleton } from '@/components/ui'

type Point = { date: string; count: number }
type Charts = {
  attendance_daily: Point[]
  absences_daily: Point[]
  by_school: { school: string; count: number }[]
  by_service: { type: string; count: number }[]
}

/**
 * Thirty days of attendance and absences, drawn by hand.
 *
 * No charting library: two series over thirty points is a polyline, and the
 * page's `script-src` would need widening for a CDN build while a bundled one
 * costs more than the whole rest of this screen. SVG also scales without the
 * canvas blur on a retina laptop, which is what an admin actually looks at.
 */
export function TrendCard() {
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'charts'],
    queryFn: () => api<Charts>('/api/admin/stats/charts'),
  })

  if (isPending) return <Skeleton className="mb-4 h-56 w-full rounded-card" />
  if (!data) return null

  const present = data.attendance_daily ?? []
  const absent = data.absences_daily ?? []
  if (present.length === 0 && absent.length === 0) return null

  // One shared scale, so the two lines are comparable rather than each
  // stretched to fill the box.
  const peak = Math.max(1, ...present.map((p) => p.count), ...absent.map((p) => p.count))
  const W = 600
  const H = 140

  const path = (points: Point[]) =>
    points
      .map((p, i) => {
        const x = points.length === 1 ? W / 2 : (i / (points.length - 1)) * W
        const y = H - (p.count / peak) * H
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

  const first = present[0]?.date ?? absent[0]?.date
  const last = present.at(-1)?.date ?? absent.at(-1)?.date

  return (
    <Card className="mb-4 p-5">
      <div className="mb-4 flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <p className="text-[1.05rem] font-extrabold text-ink-900">Last 30 days</p>
        <span className="flex items-center gap-1.5 text-[0.82rem] font-bold text-ink-500">
          <span className="size-2.5 rounded-full bg-sky-500" /> Present
        </span>
        <span className="flex items-center gap-1.5 text-[0.82rem] font-bold text-ink-500">
          <span className="size-2.5 rounded-full bg-berry-500" /> Absent
        </span>
        <span className="ml-auto text-[0.8rem] font-semibold text-ink-400">
          peak {peak}
        </span>
      </div>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-36 w-full overflow-visible"
        preserveAspectRatio="none"
        role="img"
        aria-label={`Attendance and absences from ${first} to ${last}`}
      >
        <line x1="0" y1={H} x2={W} y2={H} stroke="var(--color-canvas-200)" strokeWidth="2" />
        <path
          d={path(present)}
          fill="none"
          stroke="var(--color-sky-500)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        <path
          d={path(absent)}
          fill="none"
          stroke="var(--color-berry-500)"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>

      <div className="mt-1 flex justify-between text-[0.75rem] font-semibold text-ink-400">
        <span>{first}</span>
        <span>{last}</span>
      </div>

      {(data.by_school?.length > 0 || data.by_service?.length > 0) && (
        <div className="mt-5 grid gap-5 border-t border-canvas-200 pt-4 sm:grid-cols-2">
          <Breakdown
            title="By school"
            rows={(data.by_school ?? []).map((r) => ({
              label: r.school,
              count: r.count,
            }))}
          />
          <Breakdown
            title="By service"
            rows={(data.by_service ?? []).map((r) => ({
              label: r.type,
              count: r.count,
            }))}
          />
        </div>
      )}
    </Card>
  )
}

function Breakdown({
  title,
  rows,
}: {
  title: string
  rows: { label: string; count: number }[]
}) {
  if (rows.length === 0) return null
  const peak = Math.max(1, ...rows.map((r) => r.count))
  return (
    <div>
      <p className="mb-2 text-[0.82rem] font-bold text-ink-500">{title}</p>
      <div className="flex flex-col gap-1.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center gap-2">
            <span className="w-28 shrink-0 truncate text-[0.85rem] font-semibold text-ink-700">
              {r.label || '—'}
            </span>
            <span
              className="h-2.5 rounded-full bg-sky-500"
              style={{ width: `${Math.max(4, (r.count / peak) * 100)}%` }}
            />
            <span className="text-[0.8rem] font-bold text-ink-500">{r.count}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
