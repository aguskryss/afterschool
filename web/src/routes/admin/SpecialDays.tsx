import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Bus, CalendarClock, Car, Check, Search } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { confirmAction, notifyError, notifySuccess } from '@/lib/confirm'
import { Button, Card, EmptyState, Field, Pill, Skeleton } from '@/components/ui'

type DayChild = {
  child_id: number
  name: string
  grade_label: string | null
  school_id: number | null
  school: string | null
  coming: boolean
  on_bus: boolean
  dismissal_time: number | null
  /** What the weekly enrollment says about this weekday. */
  usual_coming: boolean
  usual_dismissal_time: number | null
}

type Day = {
  date: string
  day: string
  /** False when this is the weekly list offered as a starting point. */
  saved: boolean
  note: string | null
  updated_at: string | null
  children: DayChild[]
}

type Saved = { date: string; note: string | null; coming: number; on_bus: number }

const HOURS = [3, 4, 5, 6]

const KEY = ['admin', 'special-days'] as const

function tomorrow(): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  return d.toLocaleDateString('en-CA')
}

function longDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * A roster for one date, replacing the weekly enrollment on that date.
 *
 * For early dismissals and vacation days: only some children come, only some
 * of those ride the bus — the rest are dropped off by a parent — and a child
 * who never comes on that weekday may come for that one day, at their own
 * pickup time. The screen starts from what the weekly enrollment would do, so
 * the director only changes what is different.
 *
 * Once saved, the bus list, the headcount, the afternoon board and My day all
 * read this list for the date. A child left off it is not expected — not
 * "absent" — so no family gets asked whether they are coming.
 */
export function AdminSpecialDays() {
  const qc = useQueryClient()
  const [date, setDate] = useState(tomorrow)
  const [note, setNote] = useState('')
  const [rows, setRows] = useState<DayChild[]>([])
  const [dirty, setDirty] = useState(false)
  const [query, setQuery] = useState('')
  const [comingOnly, setComingOnly] = useState(false)

  const { data: saved } = useQuery({
    queryKey: KEY,
    queryFn: () => api<Saved[]>('/api/admin/special-days'),
  })

  const { data: day, isPending } = useQuery({
    queryKey: [...KEY, date],
    queryFn: () => api<Day>(`/api/admin/special-days/${date}`),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(date),
  })

  // A fresh copy to edit whenever another date — or a saved version of this
  // one — arrives. Edits stay local until Save, so a half-built list never
  // changes what a counselor sees at the gate.
  useEffect(() => {
    if (!day) return
    setRows(day.children)
    setNote(day.note ?? '')
    setDirty(false)
    // A saved list opens filtered to who is on it; a new one opens on
    // everyone, since the point is to go through the whole roster.
    setComingOnly(day.saved)
  }, [day])

  const save = useMutation({
    mutationFn: () =>
      api(`/api/admin/special-days/${date}`, {
        method: 'PUT',
        body: {
          note: note.trim() || null,
          children: rows
            .filter((r) => r.coming)
            .map((r) => ({
              child_id: r.child_id,
              on_bus: r.on_bus,
              dismissal_time: r.dismissal_time,
            })),
        },
      }),
    onSuccess: () => {
      notifySuccess('Special list saved')
      void qc.invalidateQueries({ queryKey: KEY })
    },
    onError: (err) =>
      notifyError(
        'Could not save the list',
        err instanceof ApiError ? err.message : undefined,
      ),
  })

  const remove = useMutation({
    mutationFn: () => api(`/api/admin/special-days/${date}`, { method: 'DELETE' }),
    onSuccess: () => {
      notifySuccess('Back to the normal list')
      void qc.invalidateQueries({ queryKey: KEY })
    },
    onError: () => notifyError('Could not remove the list'),
  })

  const update = (childId: number, patch: Partial<DayChild>) => {
    setRows((all) => all.map((r) => (r.child_id === childId ? { ...r, ...patch } : r)))
    setDirty(true)
  }

  const setSchool = (schoolKey: string, coming: boolean) => {
    setRows((all) =>
      all.map((r) => (String(r.school_id) === schoolKey ? { ...r, coming } : r)),
    )
    setDirty(true)
  }

  const coming = rows.filter((r) => r.coming)
  const onBus = coming.filter((r) => r.on_bus).length

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const out = new Map<string, { name: string; children: DayChild[] }>()
    for (const r of rows) {
      if (comingOnly && !r.coming) continue
      if (q && !r.name.toLowerCase().includes(q)) continue
      const key = String(r.school_id)
      if (!out.has(key)) out.set(key, { name: r.school ?? 'No school', children: [] })
      out.get(key)!.children.push(r)
    }
    return [...out.entries()]
  }, [rows, query, comingOnly])

  const onDelete = async () => {
    const ok = await confirmAction(
      'Use the normal list?',
      `${longDate(date)} goes back to the weekly enrollment. This special list is deleted.`,
      'Use normal list',
    )
    if (ok) remove.mutate()
  }

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Special days
      </h1>
      <p className="mb-6 max-w-2xl text-[0.95rem] font-medium text-ink-500">
        A list for one date — an early dismissal, a vacation day — that replaces
        the weekly one. Choose who comes, who rides the bus and when each child
        is picked up. Everyone else is simply not expected that day.
      </p>

      <div className="grid gap-5 lg:grid-cols-[18rem_1fr]">
        <aside className="flex flex-col gap-3">
          <Field
            label="Date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
          {(saved?.length ?? 0) > 0 && (
            <Card className="overflow-hidden">
              <p className="px-4 pt-3 pb-2 text-[0.74rem] font-extrabold tracking-wide text-ink-400 uppercase">
                Special lists
              </p>
              <ul className="divide-y divide-canvas-200">
                {saved!.map((s) => (
                  <li key={s.date}>
                    <button
                      type="button"
                      onClick={() => setDate(s.date)}
                      className={`w-full px-4 py-2.5 text-left transition-colors ${
                        s.date === date ? 'bg-sky-50' : 'hover:bg-canvas-100'
                      }`}
                    >
                      <p className="font-bold text-ink-900">{shortDate(s.date)}</p>
                      <p className="truncate text-[0.82rem] font-medium text-ink-500">
                        {s.note ? `${s.note} · ` : ''}
                        {s.coming} coming · {s.on_bus} on the bus
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </aside>

        <section className="min-w-0">
          {isPending || !day ? (
            <Skeleton className="h-64" />
          ) : (
            <>
              <Card className="mb-4 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-[1.25rem] font-extrabold tracking-tight text-ink-900">
                    {longDate(day.date)}
                  </h2>
                  {day.saved ? (
                    <Pill status="sun">
                      <CalendarClock className="size-3.5" strokeWidth={2.6} />
                      Special list
                    </Pill>
                  ) : (
                    <Pill>Normal {day.day} list — not saved</Pill>
                  )}
                </div>
                <p className="mt-1 text-[0.9rem] font-semibold text-ink-500">
                  {coming.length} coming · {onBus} on the bus ·{' '}
                  {coming.length - onBus} dropped off
                </p>
                <Field
                  className="mt-3 max-w-md"
                  label="Note (shown to counselors)"
                  placeholder="Early dismissal"
                  maxLength={200}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value)
                    setDirty(true)
                  }}
                />
                <div className="mt-4 flex flex-wrap gap-2">
                  <Button
                    loading={save.isPending}
                    disabled={day.saved && !dirty}
                    onClick={() => save.mutate()}
                  >
                    <Check className="size-4" strokeWidth={2.8} />
                    {day.saved ? 'Save changes' : 'Save special list'}
                  </Button>
                  {day.saved && (
                    <Button
                      variant="outline"
                      loading={remove.isPending}
                      onClick={onDelete}
                    >
                      Use the normal list
                    </Button>
                  )}
                </div>
              </Card>

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <label className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-full border-2 border-canvas-200 bg-white px-4">
                  <Search className="size-4 shrink-0 text-ink-400" strokeWidth={2.4} />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search a child"
                    className="min-w-0 flex-1 bg-transparent text-[0.95rem] font-medium outline-none"
                  />
                </label>
                <div className="flex rounded-full bg-canvas-100 p-1">
                  {[
                    { value: false, label: 'Everyone' },
                    { value: true, label: 'Coming' },
                  ].map((o) => (
                    <button
                      key={o.label}
                      type="button"
                      aria-pressed={comingOnly === o.value}
                      onClick={() => setComingOnly(o.value)}
                      className={`h-9 rounded-full px-4 text-[0.88rem] font-bold ${
                        comingOnly === o.value
                          ? 'bg-white text-ink-900 shadow-soft'
                          : 'text-ink-500'
                      }`}
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              </div>

              {groups.length === 0 ? (
                <Card>
                  <EmptyState
                    title="Nobody here"
                    body={
                      comingOnly
                        ? 'No child is on this list yet. Switch to Everyone to add some.'
                        : 'No child matches that search.'
                    }
                  />
                </Card>
              ) : (
                <div className="flex flex-col gap-4">
                  {groups.map(([key, group]) => {
                    const allIn = group.children.every((c) => c.coming)
                    return (
                      <Card key={key} className="overflow-hidden">
                        <div className="flex items-center gap-2 px-4 py-3">
                          <p className="min-w-0 flex-1 truncate text-[1.02rem] font-extrabold text-ink-900">
                            {group.name}
                          </p>
                          <span className="text-[0.85rem] font-bold text-ink-400">
                            {group.children.filter((c) => c.coming).length} coming
                          </span>
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setSchool(key, !allIn)}
                          >
                            {allIn ? 'Nobody' : 'Everyone'}
                          </Button>
                        </div>
                        <ul className="divide-y divide-canvas-200 border-t border-canvas-200">
                          {group.children.map((c) => (
                            <ChildRow key={c.child_id} child={c} weekday={day.day} onChange={update} />
                          ))}
                        </ul>
                      </Card>
                    )
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

function ChildRow({
  child: c,
  weekday,
  onChange,
}: {
  child: DayChild
  weekday: string
  onChange: (childId: number, patch: Partial<DayChild>) => void
}) {
  const extra = c.coming && !c.usual_coming
  const moved =
    c.coming && c.usual_coming && c.dismissal_time !== c.usual_dismissal_time
  return (
    <li
      className={`flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2.5 ${
        c.coming ? '' : 'bg-canvas-50'
      }`}
    >
      <button
        type="button"
        aria-pressed={c.coming}
        aria-label={`${c.coming ? 'Remove' : 'Add'} ${c.name}`}
        onClick={() => onChange(c.child_id, { coming: !c.coming })}
        className={`grid size-10 shrink-0 place-items-center rounded-xl border-2 transition-colors ${
          c.coming
            ? 'border-leaf-500 bg-leaf-500 text-white'
            : 'border-canvas-200 bg-white text-transparent'
        }`}
      >
        <Check className="size-5" strokeWidth={3} />
      </button>

      <div className="min-w-0 flex-1 basis-40">
        <p className={`truncate font-bold ${c.coming ? 'text-ink-900' : 'text-ink-400'}`}>
          {c.name}
        </p>
        <p className="truncate text-[0.8rem] font-semibold text-ink-400">
          {c.grade_label ? `Gr ${c.grade_label}` : ''}
          {extra && (
            <span className="font-extrabold text-sky-600">
              {c.grade_label ? ' · ' : ''}not usually on {weekday}
            </span>
          )}
          {moved && (
            <span className="font-extrabold text-sun-700">
              {c.grade_label ? ' · ' : ''}
              {c.usual_dismissal_time
                ? `usually ${c.usual_dismissal_time} PM`
                : 'no usual pickup time'}
            </span>
          )}
        </p>
      </div>

      {c.coming && (
        <div className="flex items-center gap-2">
          <div className="flex rounded-full bg-canvas-100 p-1">
            {[
              { value: true, label: 'Bus', icon: Bus },
              { value: false, label: 'Drop-off', icon: Car },
            ].map((o) => (
              <button
                key={o.label}
                type="button"
                aria-pressed={c.on_bus === o.value}
                onClick={() => onChange(c.child_id, { on_bus: o.value })}
                className={`flex h-8 items-center gap-1 rounded-full px-3 text-[0.82rem] font-bold ${
                  c.on_bus === o.value
                    ? 'bg-white text-ink-900 shadow-soft'
                    : 'text-ink-500'
                }`}
              >
                <o.icon className="size-3.5" strokeWidth={2.4} />
                {o.label}
              </button>
            ))}
          </div>
          <select
            aria-label={`Pickup time for ${c.name}`}
            value={c.dismissal_time ?? ''}
            onChange={(e) =>
              onChange(c.child_id, {
                dismissal_time: e.target.value ? Number(e.target.value) : null,
              })
            }
            className="h-10 rounded-xl border-2 border-canvas-200 bg-white px-2 text-[0.9rem] font-bold text-ink-900"
          >
            <option value="">Pickup —</option>
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {h}:00 PM
              </option>
            ))}
          </select>
        </div>
      )}
    </li>
  )
}
