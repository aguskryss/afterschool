import { useEffect } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Repeat2, Trash2 } from 'lucide-react'
import { api } from '@/lib/api'
import { confirmDelete } from '@/lib/confirm'
import { DataTable, type Column } from '@/components/DataTable'
import { Button, Pill } from '@/components/ui'

type MakeupRequest = {
  id: number
  child_name: string
  school: string | null
  action: string
  action_time: string | null
  day_of_week: string | null
  specific_date: string | null
  parent_will_pickup: boolean | number | null
  assigned_counselor_id: number | null
  counselor_locked: boolean | null
  admin_seen_at: string | null
  activity_name: string
  counselor_name: string | null
  parent_name: string | null
  parent_email: string | null
}

type Counselor = { id: number; name: string }

/**
 * Make-up classes parents booked, waiting on an adult to own them.
 *
 * Only future dates come back from the server, so this is a queue rather than
 * a history — a request that has already happened drops off by itself.
 *
 * Visiting marks the whole queue seen, which is what clears the unread count.
 * That happens on mount rather than behind a button because opening the screen
 * *is* the act of having seen them; asking for a second confirmation would only
 * leave the badge lying.
 */
export function AdminMakeupRequests() {
  const qc = useQueryClient()

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'makeup-requests'],
    queryFn: () => api<MakeupRequest[]>('/api/admin/makeup-requests'),
  })

  const { data: counselors } = useQuery({
    queryKey: ['admin', 'counselors'],
    queryFn: () => api<Counselor[]>('/api/admin/counselors'),
  })

  const markSeen = useMutation({
    mutationFn: () =>
      api('/api/admin/makeup-requests/mark-seen', { method: 'POST' }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'makeup-unseen'] }),
  })

  // Once per visit, and only when there is something unseen to clear.
  const unseen = (data ?? []).some((r) => !r.admin_seen_at)
  useEffect(() => {
    if (unseen && !markSeen.isPending) markSeen.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unseen])

  const assign = useMutation({
    mutationFn: ({ id, counselorId }: { id: number; counselorId: number | null }) =>
      api(`/api/admin/makeup-requests/${id}/assign`, {
        method: 'PUT',
        body: { counselor_id: counselorId },
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'makeup-requests'] }),
  })

  const remove = useMutation({
    mutationFn: (id: number) =>
      api(`/api/admin/makeup-requests/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['admin', 'makeup-requests'] }),
  })

  const rows = data ?? []

  const columns: Column<MakeupRequest>[] = [
    { key: 'child_name', header: 'Child' },
    { key: 'activity_name', header: 'Activity' },
    {
      key: 'specific_date',
      header: 'When',
      value: (r) => `${r.specific_date ?? ''} ${r.action_time ?? ''}`.trim(),
      render: (r) => (
        <span className="font-semibold text-ink-800">
          {r.specific_date}
          {r.action_time && (
            <span className="ml-1.5 font-medium text-ink-500">{r.action_time}</span>
          )}
        </span>
      ),
    },
    { key: 'school', header: 'School', secondary: true },
    {
      key: 'parent_name',
      header: 'Booked by',
      secondary: true,
      value: (r) => r.parent_name ?? '',
    },
    {
      key: 'assigned_counselor_id',
      header: 'Counselor',
      value: (r) => r.counselor_name ?? '',
      render: (r) => (
        <div className="flex items-center gap-2">
          <select
            value={r.assigned_counselor_id ?? ''}
            onChange={(e) =>
              assign.mutate({
                id: r.id,
                counselorId: e.target.value ? Number(e.target.value) : null,
              })
            }
            className="h-9 rounded-full border-2 border-canvas-200 bg-white px-3 text-[0.85rem] font-semibold text-ink-800 outline-none focus:border-sky-500"
          >
            <option value="">Unassigned</option>
            {(counselors ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          {/* Set by this screen: it tells the nightly cascade to leave a
              hand-picked counselor alone. */}
          {r.counselor_locked && <Pill status="neutral">Pinned</Pill>}
        </div>
      ),
    },
    {
      key: 'id',
      header: '',
      align: 'right',
      render: (r) => (
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Remove the make-up for ${r.child_name}`}
          onClick={async () => {
            if (await confirmDelete(`${r.child_name}'s make-up`))
              remove.mutate(r.id)
          }}
        >
          <Trash2 className="size-4" strokeWidth={2.1} />
        </Button>
      ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Make-up classes
      </h1>
      <DataTable
        rows={rows}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search children, activities or parents…"
        emptyIcon={<Repeat2 className="size-7" strokeWidth={1.8} />}
        emptyTitle="No make-up classes booked"
        emptyBody="Sessions parents book to replace a missed day show up here until they happen."
      />
    </div>
  )
}
