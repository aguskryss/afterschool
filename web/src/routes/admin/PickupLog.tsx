import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, Undo2, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { DataTable, type Column } from '@/components/DataTable'
import { ExportButton } from '@/components/ExportButton'
import { dismissalLabel } from '@/components/ChildStatus'
import { Button, Pill } from '@/components/ui'

type Release = {
  id: number
  child_id: number
  child_name: string
  school: string
  school_id: number
  person_name: string
  person_relationship: string | null
  counselor_name: string
  release_date: string
  released_at: string
  checked_in_at: string | null
  /** The hour (3-6, meaning 3pm-6pm) from that day's registration — null for
   * an organization that doesn't use dismissal times, same as everywhere
   * else this field appears. */
  dismissal_time: number | null
  has_signature: boolean
}

/**
 * Past the hour a child was expected to leave. `dismissal_time` is always a
 * whole PM hour (3-6), so +12 is the 24-hour form — same conversion
 * daily_routing.dismissal_clock does server-side. Both sides are read in the
 * browser's local time, same as timeOf() below, on the same assumption the
 * rest of this screen already makes: whoever is looking at it is in the
 * JCC's own timezone.
 */
function isLate(r: Release): boolean {
  if (r.dismissal_time == null) return false
  const out = new Date(r.released_at)
  const actualMinutes = out.getHours() * 60 + out.getMinutes()
  const expectedMinutes = (r.dismissal_time + 12) * 60
  return actualMinutes > expectedMinutes
}

type ReleaseDetail = {
  id: number
  child_name: string
  person_name: string
  person_relationship: string | null
  counselor_name: string
  released_at: string
  /** null for releases recorded before signatures were captured. */
  signature: string | null
  /** Only on a voided release. */
  voided_at?: string
  voided_by_name?: string
  void_reason?: string
}

/** A release an admin voided — recorded by mistake, kept as it was. */
type VoidedRelease = {
  id: number
  release_id: number
  child_id: number
  child_name: string
  school: string
  person_name: string
  person_relationship: string | null
  counselor_name: string
  release_date: string
  released_at: string
  voided_at: string
  voided_by_name: string
  void_reason: string
  has_signature: boolean
}

type Opened = { kind: 'release' | 'voided'; id: number }

const toIso = (d: Date) => d.toISOString().slice(0, 10)

function timeOf(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * Take back a release recorded by mistake. A reason is required — this
 * undoes a signed record, so it leaves one of its own. The family is not
 * told; they hear about the release that actually happens.
 */
function VoidRelease({
  releaseId,
  childName,
  onVoided,
}: {
  releaseId: number
  childName: string
  onVoided: () => void
}) {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [reason, setReason] = useState('')

  const voidIt = useMutation({
    mutationFn: () =>
      api(`/api/admin/pickup-releases/${releaseId}/void`, {
        method: 'POST',
        body: { reason: reason.trim() },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'pickup-releases'] })
      onVoided()
    },
  })

  if (!confirming) {
    return (
      <div className="mt-4 flex justify-end">
        <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
          <Undo2 className="size-4" strokeWidth={2.4} />
          Void this pickup
        </Button>
      </div>
    )
  }

  return (
    <div className="mt-4 rounded-2xl bg-berry-50 p-4">
      <p className="text-[0.88rem] font-bold text-berry-700">
        Void this pickup?
      </p>
      <p className="mt-1 text-[0.82rem] font-medium text-ink-600">
        {childName} will show as still in the building, and the correct pickup
        can be recorded as usual. This record and its signature are kept under
        “Voided pickups”. The family is not notified.
      </p>
      <label className="mt-3 flex flex-col gap-1 text-[0.8rem] font-bold text-ink-600">
        Reason
        <textarea
          rows={2}
          maxLength={500}
          value={reason}
          autoFocus
          placeholder="e.g. Wrong child selected — it was their sibling"
          onChange={(e) => setReason(e.target.value)}
          className="rounded-2xl border-2 border-canvas-200 bg-white px-4 py-2.5 text-[0.9rem] font-medium text-ink-900 outline-none focus:border-sky-500"
        />
      </label>
      {voidIt.error && (
        <p className="mt-2 text-[0.82rem] font-semibold text-berry-600">
          {voidIt.error instanceof ApiError
            ? voidIt.error.message
            : 'Could not void that pickup.'}
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setConfirming(false)
            setReason('')
            voidIt.reset()
          }}
        >
          Cancel
        </Button>
        <Button
          variant="danger"
          size="sm"
          disabled={!reason.trim()}
          loading={voidIt.isPending}
          onClick={() => voidIt.mutate()}
        >
          Void pickup
        </Button>
      </div>
    </div>
  )
}

/** The signature, fetched only when an admin opens one record. */
function SignatureModal({
  opened,
  onClose,
}: {
  opened: Opened
  onClose: () => void
}) {
  const { kind, id } = opened
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'pickup-signature', kind, id],
    queryFn: () =>
      api<ReleaseDetail>(
        kind === 'voided'
          ? `/api/admin/pickup-releases/voided/${id}/signature`
          : `/api/admin/pickup-releases/${id}/signature`,
      ),
  })

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Pickup record"
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/85 p-4"
    >
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute top-4 right-4 flex size-10 items-center justify-center rounded-full bg-white/15 text-white"
      >
        <X className="size-5" strokeWidth={2.4} />
      </button>

      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg rounded-card bg-white p-5 shadow-lift"
      >
        {isPending || !data ? (
          <p className="text-[0.88rem] font-semibold text-ink-400">Loading…</p>
        ) : (
          <>
            <h2 className="flex items-center gap-2 text-[1.1rem] font-extrabold text-ink-900">
              {data.child_name}
              {kind === 'voided' && <Pill status="berry">Voided</Pill>}
            </h2>
            {kind === 'voided' && data.voided_at && (
              <p className="mt-2 rounded-2xl bg-berry-50 px-3 py-2 text-[0.82rem] font-semibold text-berry-700">
                Voided by {data.voided_by_name} on{' '}
                {new Date(data.voided_at).toLocaleString('en-US', {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
                : <span className="font-medium">{data.void_reason}</span>
              </p>
            )}
            <p className="mt-0.5 text-[0.88rem] font-semibold text-ink-600">
              Collected by {data.person_name}
              {data.person_relationship && (
                <span className="font-medium text-ink-400">
                  {' '}
                  · {data.person_relationship}
                </span>
              )}
            </p>
            <p className="mt-0.5 text-[0.82rem] font-medium text-ink-500">
              {new Date(data.released_at).toLocaleString('en-US', {
                dateStyle: 'medium',
                timeStyle: 'short',
              })}{' '}
              · confirmed by {data.counselor_name}
            </p>

            {data.signature ? (
              <img
                src={data.signature}
                alt={`Signature of ${data.person_name}`}
                className="mt-4 w-full rounded-2xl border border-canvas-200 bg-white"
              />
            ) : (
              // Pre-dates signature capture. Saying so is the honest answer;
              // an empty frame would read as a signature that failed to load.
              <p className="mt-4 rounded-2xl bg-canvas-100 px-4 py-6 text-center text-[0.85rem] font-semibold text-ink-500">
                This pickup was recorded before signatures were captured.
              </p>
            )}

            {kind === 'release' && (
              <VoidRelease
                releaseId={id}
                childName={data.child_name}
                onVoided={onClose}
              />
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The permanent record of who collected which child, and their signature.
 *
 * Nothing here edits or deletes a release. The one correction is voiding a
 * release recorded by mistake, and that moves it — signature, reason and who
 * voided it — into the "Voided pickups" list below rather than erasing it.
 */
export function AdminPickupLog() {
  const [end, setEnd] = useState(() => toIso(new Date()))
  const [start, setStart] = useState(() =>
    toIso(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
  )
  const [open, setOpen] = useState<Opened | null>(null)

  const range = `start=${start}&end=${end}`
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'pickup-releases', start, end],
    queryFn: () =>
      api<{
        releases: Release[]
        voided: VoidedRelease[]
        truncated: boolean
      }>(`/api/admin/pickup-releases?${range}`),
  })

  const rows = data?.releases ?? []
  const voided = data?.voided ?? []

  const columns: Column<Release>[] = [
    { key: 'release_date', header: 'Date' },
    { key: 'child_name', header: 'Child' },
    { key: 'school', header: 'School', secondary: true },
    { key: 'person_name', header: 'Picked up by' },
    {
      key: 'person_relationship',
      header: 'Relationship',
      value: (r) => r.person_relationship ?? '',
      render: (r) => (
        <span className="text-ink-500">{r.person_relationship ?? '—'}</span>
      ),
    },
    {
      key: 'checked_in_at',
      header: 'In',
      secondary: true,
      value: (r) => r.checked_in_at ?? '',
      render: (r) => timeOf(r.checked_in_at),
    },
    {
      key: 'dismissal_time',
      header: 'Expected',
      secondary: true,
      value: (r) => r.dismissal_time ?? -1,
      render: (r) => {
        const label = dismissalLabel(r.dismissal_time)
        return <span className={label ? '' : 'text-ink-300'}>{label ?? '—'}</span>
      },
    },
    {
      key: 'released_at',
      header: 'Out',
      value: (r) => r.released_at,
      render: (r) => (
        <span className="flex items-center gap-2">
          {timeOf(r.released_at)}
          {isLate(r) && <Pill status="berry">Late</Pill>}
        </span>
      ),
    },
    { key: 'counselor_name', header: 'Confirmed by', secondary: true },
    {
      key: 'has_signature',
      header: 'Signed',
      align: 'right',
      value: (r) => (r.has_signature ? 'Yes' : 'No'),
      render: (r) =>
        r.has_signature ? (
          <Pill status="leaf">Signed</Pill>
        ) : (
          <Pill status="neutral">—</Pill>
        ),
    },
  ]

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Pickup record
      </h1>
      <p className="mb-6 text-[0.9rem] font-medium text-ink-500">
        Who collected each child, when, and the signature they gave. Select a
        row to see it.
      </p>

      <div className="mb-4 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-[0.85rem] font-bold text-ink-600">
          From
          <input
            type="date"
            value={start}
            max={end}
            onChange={(e) => setStart(e.target.value)}
            className="rounded-xl border border-canvas-200 bg-white px-3 py-1.5 font-semibold text-ink-900"
          />
        </label>
        <label className="flex items-center gap-2 text-[0.85rem] font-bold text-ink-600">
          To
          <input
            type="date"
            value={end}
            min={start}
            onChange={(e) => setEnd(e.target.value)}
            className="rounded-xl border border-canvas-200 bg-white px-3 py-1.5 font-semibold text-ink-900"
          />
        </label>
      </div>

      {data?.truncated && (
        <p className="mb-3 rounded-2xl bg-sun-50 px-4 py-2.5 text-[0.85rem] font-semibold text-sun-600">
          This range has more pickups than can be shown at once. Only the most
          recent are listed — narrow the dates, or use the export for the full
          range.
        </p>
      )}

      <DataTable
        rows={rows}
        columns={columns}
        loading={isPending}
        searchPlaceholder="Search children, people or schools…"
        emptyIcon={<ShieldCheck className="size-7" strokeWidth={1.8} />}
        emptyTitle="No pickups recorded"
        emptyBody="Nothing has been released in this date range."
        onRowClick={(r) => setOpen({ kind: 'release', id: r.id })}
        actions={
          <ExportButton
            path={`/api/admin/export/pickup-releases?${range}`}
            filename={`pickups-${start}-to-${end}.xlsx`}
          />
        }
      />

      {voided.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-1 text-[1.1rem] font-extrabold text-ink-900">
            Voided pickups
          </h2>
          <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
            Pickups recorded by mistake and voided by an admin. Kept as they
            were recorded, with the reason.
          </p>
          <ul className="divide-y divide-canvas-200 overflow-hidden rounded-card border border-canvas-200 bg-white">
            {voided.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  onClick={() => setOpen({ kind: 'voided', id: v.id })}
                  className="flex w-full flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-left hover:bg-canvas-100"
                >
                  <span className="text-[0.85rem] font-semibold text-ink-500">
                    {v.release_date}
                  </span>
                  <span className="text-[0.9rem] font-bold text-ink-400 line-through">
                    {v.child_name} · {v.person_name} · {timeOf(v.released_at)}
                  </span>
                  <span className="text-[0.82rem] font-medium text-ink-600">
                    Voided by {v.voided_by_name}: {v.void_reason}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {open !== null && (
        <SignatureModal opened={open} onClose={() => setOpen(null)} />
      )}
    </div>
  )
}
