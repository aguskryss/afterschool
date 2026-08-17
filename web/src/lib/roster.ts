/**
 * The counselor's day, shared by the screens that read it.
 *
 * Attendance and release used to live on one screen, so each of them fetched
 * the roster and re-declared the same mutation. They are two screens now — the
 * school gate and the door — and both need the same three things: today's
 * roster, today's marks, and one way to write a mark. Keeping that here is
 * what stops the two copies from drifting the way the roster types already
 * had.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { isGone, isHere, type AttendanceMap } from '@/lib/attendance'

export type RosterChild = {
  id: number
  name: string
  parent: string
  parent_email?: string
  release_group?: string | null
  service_type: string
  grade: string | null
  /** 3, 4, 5 or 6 — the hour they leave. NULL where the JCC doesn't use them. */
  dismissal_time: number | null
  allergies: string | null
  notes: string | null
}

export type RosterSchool = {
  school: string
  school_id: number
  date: string
  day: string
  attending: RosterChild[]
  absent: RosterChild[]
  /** Only sent to organizations with the check_in_out module. Keyed by child id. */
  times?: Record<
    string,
    { checked_in_at: string | null; checked_out_at: string | null }
  >
}

/** "4:02 PM" — arrival and departure are only ever read to the minute. */
export function hhmm(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

/* ── Queries ─────────────────────────────────────────────────────────── */

/**
 * Today's roster, or any other date's.
 *
 * No ?date= when today: "today" means today at the program, which the server
 * resolves through the organization's timezone. Sending the device's own date
 * lets a phone in the wrong zone ask for a different day than the one the JCC
 * is having, and then show a roster and a headcount that quietly belong to it.
 */
export function useRoster(date?: string) {
  return useQuery({
    queryKey: ['counselor', 'roster', date ?? 'today'],
    queryFn: () =>
      api<RosterSchool[]>(
        date ? `/api/counselor/roster?date=${date}` : '/api/counselor/roster',
      ),
  })
}

/** Where every child is today. Waits for the server to say what day it is. */
export function useAttendanceMarks(date: string | undefined) {
  return useQuery({
    queryKey: ['counselor', 'attendance', date],
    queryFn: () => api<AttendanceMap>(`/api/counselor/attendance?date=${date}`),
    enabled: Boolean(date),
  })
}

export type MarkInput = { childId: number; present: boolean }

/**
 * One tap, or a whole school at once.
 *
 * The optimistic write is not a nicety: a counselor tapping down a line of
 * forty children at a school gate cannot wait on a round trip between taps.
 * `checked_out_at` is carried through untouched — a release is never undone by
 * a tick, here or on the server.
 */
export function useMarkAttendance(date: string | undefined) {
  const qc = useQueryClient()
  const key = ['counselor', 'attendance', date]

  return useMutation({
    mutationFn: (input: MarkInput | MarkInput[]) => {
      const records = Array.isArray(input) ? input : [input]
      return api('/api/counselor/attendance', {
        method: 'POST',
        body: {
          date,
          records: records.map((r) => ({
            child_id: r.childId,
            on_bus: r.present,
          })),
        },
      })
    },
    onMutate: async (input) => {
      const records = Array.isArray(input) ? input : [input]
      await qc.cancelQueries({ queryKey: key })
      const prev = qc.getQueryData<AttendanceMap>(key)
      const next: AttendanceMap = { ...(prev ?? {}) }
      for (const { childId, present } of records) {
        const before = next[String(childId)]
        next[String(childId)] = {
          checked_in_at: before?.checked_in_at ?? null,
          checked_out_at: before?.checked_out_at ?? null,
          note: before?.note ?? null,
          on_bus: present,
          status: present ? 'picked_up' : 'waiting',
        }
      }
      qc.setQueryData<AttendanceMap>(key, next)
      return { prev }
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(key, ctx.prev)
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: key }),
  })
}

/* ── Derived state ───────────────────────────────────────────────────── */

export type SchoolProgress = {
  /** In the building right now: collected and not yet released. */
  here: number
  /** Scheduled to attend today, absences already removed. */
  total: number
  /** Already collected by a parent. */
  gone: number
  /** Children with no attendance row at all — what Submit closes out. */
  pending: RosterChild[]
  /** Every child accounted for, one way or another. */
  submitted: boolean
}

/**
 * How far along a school's attendance is.
 *
 * "Submitted" is derived, not stored: a school is done when no child is left
 * without a record for the day. That is exactly what the Submit button
 * produces — it writes "not on the bus" for whoever was never ticked — so the
 * two cannot disagree, and no new column had to exist to say so.
 */
export function schoolProgress(
  school: RosterSchool,
  marks: AttendanceMap | undefined,
): SchoolProgress {
  const pending = school.attending.filter((c) => !marks?.[String(c.id)])
  return {
    here: school.attending.filter((c) => isHere(marks?.[String(c.id)])).length,
    total: school.attending.length,
    gone: school.attending.filter((c) => isGone(marks?.[String(c.id)])).length,
    pending,
    submitted: school.attending.length > 0 && pending.length === 0,
  }
}

/* ── Search ──────────────────────────────────────────────────────────── */

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

/**
 * Placeholder text a spreadsheet uses to say "no allergy" \u2014 carried through
 * import as literal text, not a null. A truthy check on the raw field alone
 * turns every one of these into an alert a counselor has to read past.
 */
const NO_ALLERGY_TEXT = new Set([
  'n a',
  'na',
  'none',
  'no',
  'nil',
  'nka',
  'nkda',
  'no allergies',
  'no allergy',
  'no known allergies',
  'no known allergy',
  'ninguna',
  'ninguno',
  'sin alergias',
  'sin alergia',
])

/** Does this child actually carry an allergy, once placeholder text is out? */
export function hasAllergy(value: string | null | undefined): boolean {
  const normalized = fold(value ?? '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
  return normalized !== '' && !NO_ALLERGY_TEXT.has(normalized)
}

/**
 * The chip form of an allergy list.
 *
 * A ten-allergen string printed inline is a paragraph in a column 300px wide,
 * and it pushes every other row down. The first two terms plus a count is
 * enough to recognise the danger; the full text is one tap away and always
 * complete — never truncated silently.
 */
export function shortAllergy(value: string): string {
  const parts = value
    .split(/[,;/]|\band\b/i)
    .map((p) => p.trim())
    .filter(Boolean)
  if (parts.length <= 2) return parts.join(' · ') || value
  return `${parts.slice(0, 2).join(' · ')} +${parts.length - 2}`
}

/**
 * Does this child match what was typed?
 *
 * Every term has to hit, and a term hits on the start of any part of the name,
 * so "ben" finds Benjamin Cohen and "cohen ben" finds him too — nobody at a
 * door types a child's names in the order the spreadsheet happens to hold
 * them. Accents fold, because the roster carries them and phone keyboards
 * often do not.
 */
export function matchesName(name: string, query: string): boolean {
  const terms = fold(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const full = fold(name)
  const parts = full.split(/\s+/)
  return terms.every(
    (t) => parts.some((p) => p.startsWith(t)) || full.includes(t),
  )
}
