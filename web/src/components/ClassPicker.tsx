import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import { matchesName } from '@/lib/roster'

export type ClassRoster = {
  id: number
  name: string
  day_of_week: string
  start_time: string | null
  enrolled_count: number
  child_ids: number[]
}

/**
 * Every active class with the ids of the active children enrolled in it.
 *
 * Any weekday, not only today's: "the class group" is everyone enrolled in
 * the class, and the director writes to it on whatever day she needs to.
 * Only call this with daily_ops on — the route is gated by that module and
 * answers 403 otherwise.
 */
export function useClassRosters(enabled: boolean) {
  return useQuery({
    queryKey: ['admin', 'class-sessions', 'with-children'],
    queryFn: () => api<ClassRoster[]>('/api/admin/class-sessions?with_children=1'),
    enabled,
  })
}

/**
 * Chips for every class, grouped by weekday, with a search box — a JCC has
 * dozens of classes and five rows of them is too many to scan unfiltered.
 */
export function ClassPicker({
  classes,
  selected,
  onToggle,
  accent = 'sky',
}: {
  classes: ClassRoster[] | undefined
  selected: number[]
  onToggle: (c: ClassRoster) => void
  accent?: 'sky' | 'grape'
}) {
  const [query, setQuery] = useState('')

  const byDay = useMemo(() => {
    const groups: { day: string; items: ClassRoster[] }[] = []
    for (const c of classes ?? []) {
      if (query.trim() && !matchesName(c.name, query)) continue
      const last = groups[groups.length - 1]
      if (last && last.day === c.day_of_week) last.items.push(c)
      else groups.push({ day: c.day_of_week, items: [c] })
    }
    return groups
  }, [classes, query])

  const onClass = accent === 'grape' ? 'bg-grape-500 text-white' : 'bg-sky-500 text-white'
  const focus = accent === 'grape' ? 'focus:border-grape-500' : 'focus:border-sky-500'

  if (classes && classes.length === 0) {
    return (
      <p className="text-[0.85rem] font-semibold text-ink-400">
        There are no classes yet. Add them on the Classes screen.
      </p>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <input
        type="search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search a class"
        aria-label="Search a class"
        className={`w-full rounded-2xl border-2 border-canvas-200 px-4 py-2 text-[0.88rem] font-medium outline-none ${focus}`}
      />
      <div className="flex max-h-72 flex-col gap-3 overflow-y-auto pr-1">
        {byDay.map((g) => (
          <div key={g.day}>
            <p className="mb-1.5 text-[0.75rem] font-extrabold tracking-wide text-ink-400 uppercase">
              {g.day}
            </p>
            <div className="flex flex-wrap gap-2">
              {g.items.map((c) => {
                const on = selected.includes(c.id)
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => onToggle(c)}
                    className={`rounded-full px-3.5 py-1.5 text-[0.85rem] font-bold transition-colors ${
                      on
                        ? onClass
                        : 'border-2 border-canvas-200 text-ink-600 hover:bg-canvas-100'
                    }`}
                  >
                    {c.name}
                    {c.start_time ? ` · ${c.start_time}` : ''}
                    <span className={on ? 'opacity-80' : 'text-ink-400'}>
                      {' '}
                      ({c.enrolled_count})
                    </span>
                  </button>
                )
              })}
            </div>
          </div>
        ))}
        {classes && byDay.length === 0 && (
          <p className="text-[0.85rem] font-semibold text-ink-400">No class matches.</p>
        )}
      </div>
    </div>
  )
}
