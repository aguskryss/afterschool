import { useState } from 'react'
import { Download } from 'lucide-react'
import { ApiError, download } from '@/lib/api'
import { Button } from '@/components/ui'

/**
 * Downloads a spreadsheet the server generates.
 *
 * Deliberately placed next to the data it exports rather than gathered on an
 * "Exports" screen. Two reasons: an export is only meaningful with the filters
 * already on screen — a date, a range — and a shared screen would have to ask
 * `hasModule` before offering the absences export, which is the mistake this
 * codebase keeps making. Here each button inherits the gating of the screen it
 * sits on.
 */
export function ExportButton({
  path,
  filename,
  label = 'Export',
}: {
  path: string
  filename: string
  label?: string
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        loading={busy}
        onClick={async () => {
          setBusy(true)
          setError('')
          try {
            await download(path, filename)
          } catch (err) {
            setError(
              err instanceof ApiError ? err.message : 'That export could not be built.',
            )
          } finally {
            setBusy(false)
          }
        }}
      >
        {!busy && <Download className="size-4" strokeWidth={2.1} />}
        {label}
      </Button>
      {error && (
        <span className="text-[0.78rem] font-semibold text-berry-600">{error}</span>
      )}
    </div>
  )
}
