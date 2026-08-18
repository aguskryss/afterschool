import { useMemo, useState } from 'react'
import { ChevronRight, DoorOpen, Search, TriangleAlert, X } from 'lucide-react'
import { isGone, isHere } from '@/lib/attendance'
import {
  hasAllergy,
  hhmm,
  matchesName,
  useAttendanceMarks,
  useRoster,
  type RosterChild,
} from '@/lib/roster'
import { Avatar, Card, EmptyState, Pill, Skeleton } from '@/components/ui'
import { ReleaseChild } from '@/components/ReleaseChild'
import { dismissalLabel } from '@/components/ChildStatus'

type Present = RosterChild & {
  school: string
  checked_in_at: string | null
  checked_out_at: string | null
}

/* ── Search ──────────────────────────────────────────────────────────── */

function SearchBox({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  return (
    // Sticky under the app header: with sixty children in the building, the
    // search field is the screen, and scrolling to reach it would defeat it.
    <div className="sticky top-14 z-[5] -mx-5 mb-4 bg-canvas-50/95 px-5 py-2 backdrop-blur">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-400"
          strokeWidth={2.4}
        />
        <input
          type="search"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Search by first or last name"
          aria-label="Search children by name"
          // The browser's own clear button is suppressed: it lands a second
          // cross right beside this one, and only one of them is ours.
          className="h-12 w-full appearance-none rounded-full border-2 border-canvas-200 bg-white pr-11 pl-11 text-[0.95rem] font-medium text-ink-900 outline-none transition [&::-webkit-search-cancel-button]:appearance-none placeholder:font-normal placeholder:text-ink-400 focus:border-sky-500"
        />
        {value && (
          <button
            type="button"
            aria-label="Clear search"
            onClick={() => onChange('')}
            className="absolute top-1/2 right-2 flex size-8 -translate-y-1/2 items-center justify-center rounded-full text-ink-400 transition-colors hover:bg-canvas-100 hover:text-ink-700"
          >
            <X className="size-4" strokeWidth={2.6} />
          </button>
        )}
      </div>
    </div>
  )
}

/* ── A child at the door ─────────────────────────────────────────────── */

function subtitle(child: Present, showSchool: boolean): string {
  const out = dismissalLabel(child.dismissal_time)
  // Times first, school last: the school is the longest string and the least
  // useful at the door, so it is the one that should lose its tail to the
  // ellipsis rather than "In at 2:3…".
  const bits = [
    child.checked_in_at ? `In at ${hhmm(child.checked_in_at)}` : null,
    out ? `Out ${out}` : null,
    showSchool ? child.school : null,
  ].filter(Boolean)
  return bits.join(' · ')
}

/* ── Releasing children to their parents ─────────────────────────────── */

/**
 * The door: who is in the building, and handing them over.
 *
 * This is the other half of what used to be one screen. Attendance is a list
 * you go down in order at a school gate; a release is a single child, named by
 * whoever is standing in front of you, found among everyone who came today.
 * Those want opposite things from a list — one wants every name, the other
 * wants one name fast — which is why searching lives here and nowhere else.
 *
 * The times shown are the ones already being recorded: arrival when a
 * counselor ticks a child on the bus, departure when a parent signs. Nothing
 * new is written here that the admin's pickup log did not already receive.
 *
 * The whole screen sits behind `secure_pickup` at the route, so the release
 * flow does not have to ask again.
 *
 * SHARED WITH THE ADMIN PORTAL. A parent sometimes walks up to the office
 * instead of the school-gate counselor — someone still has to take the
 * signature. Rather than a second implementation, App.tsx mounts this same
 * component at /pickup-release under AdminShell; the data hooks below
 * (useRoster, useAttendanceMarks) and ReleaseChild's own endpoints already
 * accept an admin session, so nothing here has to know which portal it is in.
 */
export function PickupRelease() {
  const [query, setQuery] = useState('')
  const [openChild, setOpenChild] = useState<number | null>(null)

  const { data: roster, isPending } = useRoster()
  const date = roster?.[0]?.date
  const { data: marks } = useAttendanceMarks(date)

  const showSchool = (roster?.length ?? 0) > 1

  const { here, gone } = useMemo(() => {
    const all: Present[] = (roster ?? []).flatMap((s) =>
      s.attending.map((c) => ({
        ...c,
        school: s.school,
        checked_in_at: marks?.[String(c.id)]?.checked_in_at ?? null,
        checked_out_at: marks?.[String(c.id)]?.checked_out_at ?? null,
      })),
    )
    // Across schools the server's per-school ordering no longer holds, and a
    // list you search by name has to be in name order.
    all.sort((a, b) => a.name.localeCompare(b.name))
    return {
      here: all.filter((c) => isHere(marks?.[String(c.id)])),
      gone: all.filter((c) => isGone(marks?.[String(c.id)])),
    }
  }, [roster, marks])

  const matchedHere = here.filter((c) => matchesName(c.name, query))
  const matchedGone = gone.filter((c) => matchesName(c.name, query))
  const searching = query.trim().length > 0

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <header className="mb-4">
        <h1 className="text-[1.75rem] font-extrabold tracking-tight text-ink-900">
          Pickup
        </h1>
        <p className="mt-0.5 text-[0.9rem] font-semibold text-ink-400">
          {isPending
            ? 'Loading…'
            : `${here.length} in the building · ${gone.length} picked up`}
        </p>
      </header>

      <SearchBox value={query} onChange={setQuery} />

      {isPending ? (
        <Skeleton className="h-52" />
      ) : (
        <>
          <p className="mb-2.5 px-1 text-[0.74rem] font-extrabold tracking-wide text-ink-400 uppercase">
            In the building
          </p>

          {matchedHere.length === 0 ? (
            <Card className="mb-6">
              <EmptyState
                icon={<DoorOpen className="size-7" strokeWidth={1.8} />}
                title={searching ? 'No match' : 'Nobody checked in yet'}
                body={
                  searching
                    ? `No child in the building matches “${query.trim()}”.`
                    : 'Children appear here as soon as they are marked on the bus at their school.'
                }
              />
            </Card>
          ) : (
            <Card className="mb-6 overflow-hidden">
              <ul className="divide-y divide-canvas-200">
                {matchedHere.map((child) => (
                  <li key={child.id} className="flex flex-col">
                    <button
                      type="button"
                      aria-expanded={openChild === child.id}
                      onClick={() =>
                        setOpenChild((c) => (c === child.id ? null : child.id))
                      }
                      className={`flex items-center gap-3 px-4 py-3 text-left transition-colors ${
                        openChild === child.id
                          ? 'bg-canvas-100'
                          : 'hover:bg-canvas-100 active:bg-canvas-200'
                      }`}
                    >
                      <Avatar name={child.name} id={child.id} />
                      <div className="min-w-0 flex-1">
                        <p className="flex items-center gap-1.5 truncate font-bold text-ink-900">
                          {child.name}
                          {hasAllergy(child.allergies) && (
                            <TriangleAlert
                              className="size-3.5 shrink-0 text-coral-500"
                              strokeWidth={2.6}
                              aria-label={`Allergies: ${child.allergies}`}
                            />
                          )}
                        </p>
                        <p className="truncate text-[0.82rem] font-medium text-ink-500">
                          {subtitle(child, showSchool)}
                        </p>
                      </div>
                      <span className="flex shrink-0 items-center gap-1 text-[0.82rem] font-extrabold text-teal-600">
                        Release
                        <ChevronRight
                          className={`size-4 transition-transform ${
                            openChild === child.id ? 'rotate-90' : ''
                          }`}
                          strokeWidth={2.6}
                        />
                      </span>
                    </button>

                    {openChild === child.id && date && (
                      <div className="px-4 pb-3">
                        <ReleaseChild
                          childId={child.id}
                          childName={child.name}
                          date={date}
                          onDone={() => setOpenChild(null)}
                        />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </Card>
          )}

          {/* Kept on the screen rather than hidden once a child leaves: "did
              Maya already go?" is asked at the door all afternoon, and the
              answer has a name and a time attached. */}
          {matchedGone.length > 0 && (
            <>
              <p className="mb-2.5 px-1 text-[0.74rem] font-extrabold tracking-wide text-ink-400 uppercase">
                Picked up today
              </p>
              <Card className="overflow-hidden">
                <ul className="divide-y divide-canvas-200">
                  {matchedGone.map((child) => (
                    <li
                      key={child.id}
                      className="flex items-center gap-3 bg-canvas-50 px-4 py-3"
                    >
                      <Avatar name={child.name} id={child.id} />
                      <div className="min-w-0 flex-1">
                        <p className="truncate font-bold text-ink-500">
                          {child.name}
                        </p>
                        <p className="truncate text-[0.82rem] font-medium text-ink-400">
                          {child.checked_out_at
                            ? `Left at ${hhmm(child.checked_out_at)}`
                            : 'Picked up by parent'}
                          {showSchool && ` · ${child.school}`}
                        </p>
                      </div>
                      <Pill status="neutral">Gone</Pill>
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  )
}
