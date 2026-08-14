/**
 * The counselor's view of where each child is today.
 *
 * `GET /api/counselor/attendance` used to return `{child_id: on_bus}` and
 * nothing else, which is why a child released to a parent an hour earlier
 * still showed as checked in: the screen had no way to know they had gone.
 * "Picked up by a parent" and "in the building" were the same bit.
 */

export type ChildStatus =
  | 'waiting'
  | 'picked_up'
  | 'checked_out'
  | 'absent'
  | 'not_found'
  | 'issue'

export type AttendanceMark = {
  /** The checkbox state. Still `on_bus`, so the tap behaves as it always did. */
  on_bus: boolean
  status: ChildStatus | null
  note: string | null
  checked_in_at: string | null
  checked_out_at: string | null
}

export type AttendanceMap = Record<string, AttendanceMark>

/** Labels. `picked_up` and `checked_out` are the two that were conflated, so
 *  they are named for the two different people doing the collecting. */
export const STATUS_LABEL: Record<ChildStatus, string> = {
  waiting: 'Waiting at school',
  picked_up: 'In the building',
  checked_out: 'Picked up by parent',
  absent: 'Absent',
  not_found: 'Not found',
  issue: 'Issue',
}

export const STATUS_TONE: Record<
  ChildStatus,
  'leaf' | 'sun' | 'berry' | 'coral' | 'neutral'
> = {
  waiting: 'neutral',
  picked_up: 'leaf',
  checked_out: 'neutral',
  absent: 'sun',
  not_found: 'coral',
  issue: 'berry',
}

/** Has this child left with a parent? Then no tap should say otherwise. */
export function isGone(mark: AttendanceMark | undefined): boolean {
  return Boolean(mark?.checked_out_at)
}

/** In the building right now: collected from school and not yet released. */
export function isHere(mark: AttendanceMark | undefined): boolean {
  return Boolean(mark?.on_bus) && !isGone(mark)
}
