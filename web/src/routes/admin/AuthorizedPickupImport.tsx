import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { CircleCheckBig, ShieldCheck, TriangleAlert, Upload } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Card } from '@/components/ui'

type Miss = { row: number; name: string }
type Ambiguous = Miss & { count: number }

type Result = {
  rows_read: number
  matched: number
  people_added: number
  people_updated: number
  unmatched: Miss[]
  ambiguous: Ambiguous[]
}

/**
 * Bulk-load who may collect each child, from the membership system's export,
 * instead of every family adding their own list by hand in the app.
 *
 * No staging screen like Import roster: this is purely additive — it never
 * deletes or deactivates anything, and re-uploading the same file is a
 * no-op — so there is nothing to approve before it happens. What it does
 * report, per row, is which children it could not place with certainty:
 * unmatched (no child by that name) and ambiguous (more than one), so a
 * fixable file problem shows up as a short list rather than a wrong pickup
 * list on the wrong child.
 */
export function AdminAuthorizedPickupImport() {
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [result, setResult] = useState<Result | null>(null)

  const upload = useMutation({
    mutationFn: () => {
      const form = new FormData()
      form.append('file', file as File)
      return api<Result>('/api/admin/authorized-pickup-import', {
        method: 'POST',
        body: form,
      })
    },
    onSuccess: (data) => {
      setResult(data)
      setFile(null)
      setError('')
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : 'That file could not be read.'),
  })

  return (
    <div className="mx-auto w-full max-w-3xl">
      <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Import pickup list
      </h1>
      <p className="mb-6 text-[0.9rem] font-medium text-ink-500">
        Who may collect each child, loaded from the membership system's export
        instead of every family typing their own list into the app.
      </p>

      <Card className="mb-4 p-6">
        <p className="mb-5 rounded-2xl bg-canvas-100 p-4 text-[0.9rem] font-medium text-ink-700">
          Only adds and refreshes names — nothing here is ever removed or
          deactivated, and importing the same file twice changes nothing the
          second time. Both Parent/Guardian columns and every Approved Person
          come in, however many the file carries.
        </p>

        <label className="flex cursor-pointer flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-canvas-200 px-6 py-10 text-center transition-colors hover:bg-canvas-100">
          <Upload className="size-7 text-ink-400" strokeWidth={1.8} />
          <span className="font-bold text-ink-800">
            {file ? file.name : 'Choose the pickup list spreadsheet'}
          </span>
          <span className="text-[0.85rem] text-ink-500">
            Excel (.xlsx, .xlsm) — columns are matched by header name, in any
            order
          </span>
          <input
            type="file"
            accept=".xlsx,.xlsm"
            className="hidden"
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null)
              setError('')
              setResult(null)
            }}
          />
        </label>

        {error && (
          <p className="mt-4 text-[0.9rem] font-semibold text-berry-600">{error}</p>
        )}

        <div className="mt-5 flex justify-end">
          <Button
            disabled={!file}
            loading={upload.isPending}
            onClick={() => upload.mutate()}
          >
            {upload.isPending ? 'Importing…' : 'Import'}
          </Button>
        </div>
      </Card>

      {result && (
        <Card className="p-6">
          <div className="mb-4 flex items-center gap-2">
            <CircleCheckBig className="size-5 text-leaf-600" strokeWidth={2.2} />
            <h2 className="text-[1.05rem] font-extrabold text-ink-900">
              {result.matched} of {result.rows_read} children matched
            </h2>
          </div>
          <p className="mb-4 text-[0.9rem] font-medium text-ink-600">
            <span className="font-extrabold text-ink-900">{result.people_added}</span>{' '}
            {result.people_added === 1 ? 'person' : 'people'} added,{' '}
            <span className="font-extrabold text-ink-900">{result.people_updated}</span>{' '}
            {result.people_updated === 1 ? 'relationship' : 'relationships'} refreshed
            on names already on a list.
          </p>

          {result.ambiguous.length > 0 && (
            <div className="mb-4 rounded-2xl bg-sun-50 p-4">
              <p className="mb-2 flex items-center gap-2 text-[0.88rem] font-extrabold text-sun-700">
                <TriangleAlert className="size-4" strokeWidth={2.4} />
                {result.ambiguous.length} row
                {result.ambiguous.length === 1 ? '' : 's'} matched more than
                one child — skipped rather than guessing
              </p>
              <ul className="flex flex-col gap-1 text-[0.85rem] font-semibold text-sun-700">
                {result.ambiguous.map((a) => (
                  <li key={a.row}>
                    Row {a.row}: {a.name} — {a.count} children with that name
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.unmatched.length > 0 && (
            <div className="rounded-2xl bg-canvas-100 p-4">
              <p className="mb-2 flex items-center gap-2 text-[0.88rem] font-extrabold text-ink-700">
                <ShieldCheck className="size-4" strokeWidth={2.4} />
                {result.unmatched.length} row
                {result.unmatched.length === 1 ? '' : 's'} didn't match a
                child on the roster
              </p>
              <ul className="flex flex-col gap-1 text-[0.85rem] font-semibold text-ink-600">
                {result.unmatched.map((m) => (
                  <li key={m.row}>
                    Row {m.row}: {m.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
