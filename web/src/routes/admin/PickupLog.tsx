import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ShieldCheck, X } from 'lucide-react'
import { api } from '@/lib/api'
import { DataTable, type Column } from '@/components/DataTable'
import { ExportButton } from '@/components/ExportButton'
import { Pill } from '@/components/ui'

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
  has_signature: boolean
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
}

const toIso = (d: Date) => d.toISOString().slice(0, 10)

function timeOf(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/** The signature, fetched only when an admin opens one record. */
function SignatureModal({
  releaseId,
  onClose,
}: {
  releaseId: number
  onClose: () => void
}) {
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'pickup-signature', releaseId],
    queryFn: () =>
      api<ReleaseDetail>(`/api/admin/pickup-releases/${releaseId}/signature`),
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
            <h2 className="text-[1.1rem] font-extrabold text-ink-900">
              {data.child_name}
            </h2>
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
          </>
        )}
      </div>
    </div>
  )
}

/**
 * The permanent record of who collected which child, and their signature.
 *
 * Read-only by design. Nothing in the app edits or deletes a release — the
 * value of this screen is that what it shows is what happened.
 */
export function AdminPickupLog() {
  const [end, setEnd] = useState(() => toIso(new Date()))
  const [start, setStart] = useState(() =>
    toIso(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)),
  )
  const [open, setOpen] = useState<number | null>(null)

  const range = `start=${start}&end=${end}`
  const { data, isPending } = useQuery({
    queryKey: ['admin', 'pickup-releases', start, end],
    queryFn: () =>
      api<{ releases: Release[]; truncated: boolean }>(
        `/api/admin/pickup-releases?${range}`,
      ),
  })

  const rows = data?.releases ?? []

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
      key: 'released_at',
      header: 'Out',
      value: (r) => r.released_at,
      render: (r) => timeOf(r.released_at),
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
    <div className="mx-auto w-full max-w-6xl">
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
        onRowClick={(r) => setOpen(r.id)}
        actions={
          <ExportButton
            path={`/api/admin/export/pickup-releases?${range}`}
            filename={`pickups-${start}-to-${end}.xlsx`}
          />
        }
      />

      {open !== null && (
        <SignatureModal releaseId={open} onClose={() => setOpen(null)} />
      )}
    </div>
  )
}
