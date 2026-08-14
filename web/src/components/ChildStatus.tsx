import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, TriangleAlert } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Pill } from '@/components/ui'
import {
  STATUS_LABEL,
  STATUS_TONE,
  type AttendanceMark,
  type ChildStatus as Status,
} from '@/lib/attendance'

/**
 * The states a tap cannot express.
 *
 * The tick is the whole workflow ninety-nine times out of a hundred — a
 * counselor going down a line of forty children wants one tap each, not a
 * menu. So this stays folded away and only opens for the afternoon that goes
 * wrong: a child who is not at the gate, or something the director needs to
 * know about.
 *
 * `checked_out` is absent on purpose. Releasing a child to a parent takes a
 * signature on the counselor's device (spec R6) and goes through the release
 * flow; offering it here would be a way to sign a child out without signing
 * for them.
 */
const OPTIONS: { value: Status; help: string }[] = [
  { value: 'waiting', help: 'At the school, not collected yet' },
  { value: 'not_found', help: 'Not at the gate' },
  { value: 'absent', help: "Didn't come today" },
  { value: 'issue', help: 'Something the office should see' },
]

export function ChildStatusControl({
  childId,
  childName,
  date,
  mark,
}: {
  childId: number
  childName: string
  date: string
  mark: AttendanceMark | undefined
}) {
  const qc = useQueryClient()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')

  const set = useMutation({
    mutationFn: (status: Status) =>
      api('/api/counselor/child-status', {
        method: 'POST',
        body: { child_id: childId, status, date, note: note.trim() || null },
      }),
    onSuccess: () => {
      setOpen(false)
      setNote('')
      setError('')
      void qc.invalidateQueries({ queryKey: ['counselor', 'attendance', date] })
    },
    onError: (e) =>
      setError(e instanceof ApiError ? e.message : 'Could not save that.'),
  })

  const current = mark?.status
  const exceptional = current && !['picked_up', 'waiting'].includes(current)

  return (
    <>
      {/* A trigger, not a row. Giving every child their own "more" line
          doubles the height of a forty-child roster, and scrolling past forty
          buttons to find a name is the opposite of what this screen is for.
          It sits beside the tick and costs no vertical space. */}
      <button
        type="button"
        aria-label={`More options for ${childName}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`flex w-11 shrink-0 items-center justify-center border-l border-canvas-200 transition-colors ${
          open ? 'bg-canvas-100 text-ink-800' : 'text-ink-400 hover:bg-canvas-100'
        }`}
      >
        <ChevronDown
          className={`size-4 transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={2.6}
        />
      </button>

      {/* The exceptional states earn a badge on the row itself. "Picked up" is
          already the green row and repeating it would be noise on every line. */}
      {!open && exceptional && (
        <div className="flex w-full items-center gap-2 px-4 pb-2.5">
          <Pill status={STATUS_TONE[current]}>{STATUS_LABEL[current]}</Pill>
          {mark?.note && (
            <span className="inline-flex items-center gap-1 truncate text-[0.78rem] font-semibold text-ink-500">
              <TriangleAlert className="size-3.5 shrink-0" strokeWidth={2.4} />
              {mark.note}
            </span>
          )}
        </div>
      )}

      {open && (
        <div className="w-full px-4 pb-3">
          <div className="rounded-2xl bg-canvas-100 p-3">
            <p className="mb-2 text-[0.82rem] font-bold text-ink-700">
              {childName}
            </p>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {OPTIONS.map((o) => (
              <button
                key={o.value}
                type="button"
                title={o.help}
                disabled={set.isPending}
                onClick={() => set.mutate(o.value)}
                className={`rounded-full px-3 py-1.5 text-[0.82rem] font-bold transition-colors ${
                  current === o.value
                    ? 'bg-ink-800 text-white'
                    : 'bg-white text-ink-700 hover:bg-canvas-200'
                }`}
              >
                {STATUS_LABEL[o.value]}
              </button>
            ))}
          </div>
          {/* An issue with no description is a flag nobody can act on, and
              the server refuses it — so say so before the round trip. */}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What happened? (required for Issue)"
            className="h-10 w-full rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-medium text-ink-900 outline-none placeholder:font-normal placeholder:text-ink-400 focus:border-sky-500"
          />
          {error && (
            <p className="mt-2 text-[0.82rem] font-bold text-berry-600">
              {error}
            </p>
          )}
            <div className="mt-2 flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** "3:00 PM" — the program runs exactly four dismissal hours, all afternoon. */
export function dismissalLabel(hour: number | null): string | null {
  return hour === null ? null : `${hour}:00 PM`
}

/**
 * The line under a child's name on a counselor's screen: who they are and
 * when they go home. Falls back to what was there before for a JCC that
 * carries none of the roster fields.
 */
export function childSubtitle(child: {
  grade: string | null
  dismissal_time: number | null
  service_type: string
}): string {
  const bits = [
    child.grade ? `Grade ${child.grade}` : null,
    dismissalLabel(child.dismissal_time),
  ].filter(Boolean)
  return bits.length ? bits.join(' · ') : child.service_type
}
