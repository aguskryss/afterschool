import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, Circle, Search, Siren } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { readSession } from '@/lib/auth'
import { confirmAction, notifyError } from '@/lib/confirm'
import { Avatar, Button, Card, EmptyState, Field, Pill, Skeleton } from '@/components/ui'

/**
 * Where the routing engine has the child at that hour — a class, or the care
 * room they wait in. Null without daily_ops, outside the 3-6pm blocks, or for
 * a child the plan has nowhere for.
 */
type Group = { kind: 'class' | 'care'; name: string; location: string | null }

type CheckChild = {
  child_id: number
  name: string
  grade: string | null
  school: string
  photo_url: string | null
  group: Group | null
  /** Checked in after the check started, so not in its snapshot. */
  late: boolean
  accounted_at: string | null
  accounted_by: string | null
  released_at: string | null
}

type Check = {
  id: number
  date: string
  note: string | null
  started_at: string
  started_by: string | null
  ended_at: string | null
  ended_by: string | null
  total: number
  accounted: number
  released: number
  missing: number
  children: CheckChild[]
}

type PastCheck = {
  id: number
  check_date: string
  note: string | null
  started_at: string
  ended_at: string
  started_by: string | null
  total: number
  accounted: number
  released: number
  missing: number
}

type Overview = { active: Check | null; recent: PastCheck[] }

const KEY = ['admin', 'emergency'] as const

const groupLabel = (g: Group) =>
  `${g.kind === 'class' ? 'Class' : 'Care'} · ${g.name}${g.location ? ` (${g.location})` : ''}`

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })

const dateTime = (iso: string) =>
  new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })

/**
 * Re-read whenever anyone ticks a child, or a release lands mid-check.
 *
 * Rides the headcount stream like the Live board: the server forwards the
 * `emergency` signal on it, so several adults on several devices see one list
 * without each holding a second SSE thread for the length of the drill.
 */
function useEmergencyStream(onChange: () => void) {
  useEffect(() => {
    const session = readSession()
    if (!session) return
    const source = new EventSource(
      `/api/attendance/stream?token=${encodeURIComponent(session.token)}`,
    )
    source.addEventListener('emergency', onChange)
    source.addEventListener('headcount', onChange)
    return () => source.close()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="min-w-20">
      <p className={`text-[2rem] leading-none font-extrabold ${value === 0 ? 'text-ink-300' : tone}`}>
        {value}
      </p>
      <p className="mt-1 text-[0.72rem] font-bold tracking-wide text-ink-400 uppercase">
        {label}
      </p>
    </div>
  )
}

/**
 * One child, one big target. Tapping toggles "accounted for"; the row is the
 * button so a thumb on a phone in a parking lot can hit it.
 */
function ChildRow({
  child,
  onToggle,
  readOnly,
}: {
  child: CheckChild
  onToggle?: () => void
  readOnly?: boolean
}) {
  const found = !!child.accounted_at
  const wentHome = !found && !!child.released_at
  const tone = found
    ? 'border-leaf-500 bg-leaf-50'
    : wentHome
      ? 'border-canvas-200 bg-canvas-100'
      : 'border-coral-500 bg-white'
  return (
    <li>
      <button
        type="button"
        disabled={readOnly}
        onClick={onToggle}
        className={`flex w-full items-center gap-3 rounded-2xl border-2 px-4 py-3 text-left transition-colors disabled:cursor-default ${tone} ${readOnly ? '' : 'active:scale-[0.99]'}`}
      >
        <Avatar name={child.name} id={child.child_id} photoUrl={child.photo_url} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-extrabold text-ink-900">{child.name}</p>
          {child.group && (
            <p className="truncate text-[0.85rem] font-bold text-sky-700">
              {groupLabel(child.group)}
            </p>
          )}
          <p className="truncate text-[0.82rem] font-semibold text-ink-500">
            {child.grade ? `Grade ${child.grade} · ` : ''}
            {child.school}
          </p>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {child.late && <Pill status="sun">Arrived after start</Pill>}
            {child.released_at && (
              <Pill status="neutral">Went home {time(child.released_at)}</Pill>
            )}
            {found && (
              <span className="text-[0.78rem] font-semibold text-leaf-700">
                Found {time(child.accounted_at!)}
                {child.accounted_by ? ` · ${child.accounted_by}` : ''}
              </span>
            )}
          </div>
        </div>
        {found ? (
          <CheckCircle2 className="size-8 shrink-0 text-leaf-600" strokeWidth={2.2} />
        ) : (
          <Circle
            className={`size-8 shrink-0 ${wentHome ? 'text-ink-300' : 'text-coral-500'}`}
            strokeWidth={2.2}
          />
        )}
      </button>
    </li>
  )
}

/** The list, grouped by school, with a search and a missing-only filter. */
function ChildList({
  check,
  onToggle,
}: {
  check: Check
  onToggle?: (child: CheckChild) => void
}) {
  const [query, setQuery] = useState('')
  const [onlyMissing, setOnlyMissing] = useState(!check.ended_at)
  const q = query.trim().toLowerCase()
  const shown = check.children.filter(
    (c) =>
      (!onlyMissing || (!c.accounted_at && !c.released_at)) &&
      (!q ||
        c.name.toLowerCase().includes(q) ||
        !!c.group?.name.toLowerCase().includes(q)),
  )
  // By group when the plan places anyone — that is where an adult goes to
  // look — and by school otherwise, which is all a JCC without daily_ops has.
  // Classes first, then care rooms, then whoever the plan has nowhere for.
  const byGroup = check.children.some((c) => c.group)
  const sectionOf = (c: CheckChild) =>
    byGroup ? (c.group ? groupLabel(c.group) : 'No group at this hour') : c.school
  const rank = (c: CheckChild) =>
    !byGroup ? 0 : c.group?.kind === 'class' ? 0 : c.group?.kind === 'care' ? 1 : 2
  const sections = new Map<string, CheckChild[]>()
  for (const c of [...shown].sort(
    (a, b) => rank(a) - rank(b) || sectionOf(a).localeCompare(sectionOf(b)),
  )) {
    sections.set(sectionOf(c), [...(sections.get(sectionOf(c)) ?? []), c])
  }

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-ink-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a child or group…"
            className="h-11 w-full rounded-full border-2 border-canvas-200 bg-white pr-4 pl-10 text-[0.95rem] font-medium text-ink-900 outline-none focus:border-sky-500"
          />
        </div>
        <div className="flex rounded-full border-2 border-canvas-200 bg-white p-1">
          {[
            { on: true, label: `Missing (${check.missing})` },
            { on: false, label: `Everyone (${check.total})` },
          ].map((opt) => (
            <button
              key={opt.label}
              type="button"
              onClick={() => setOnlyMissing(opt.on)}
              className={`rounded-full px-4 py-1.5 text-[0.85rem] font-bold ${
                onlyMissing === opt.on ? 'bg-ink-900 text-white' : 'text-ink-600'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="font-extrabold text-ink-800">
            {onlyMissing && !q ? 'Everyone is accounted for.' : 'No child matches.'}
          </p>
        </Card>
      ) : (
        [...sections.entries()].map(([section, kids]) => (
          <section key={section} className="mb-6">
            <h2 className="mb-2 text-[0.8rem] font-extrabold tracking-wide text-ink-400 uppercase">
              {section} · {kids.length}
            </h2>
            <ul className="grid gap-2 md:grid-cols-2 2xl:grid-cols-3">
              {kids.map((c) => (
                <ChildRow
                  key={c.child_id}
                  child={c}
                  readOnly={!onToggle}
                  onToggle={onToggle ? () => onToggle(c) : undefined}
                />
              ))}
            </ul>
          </section>
        ))
      )}
    </>
  )
}

function Summary({ check }: { check: Check }) {
  return (
    <div className="flex flex-wrap gap-6">
      <Stat label="Missing" value={check.missing} tone="text-coral-600" />
      <Stat label="Accounted for" value={check.accounted} tone="text-leaf-600" />
      <Stat label="Went home" value={check.released} tone="text-ink-700" />
      <Stat label="On the list" value={check.total} tone="text-ink-900" />
    </div>
  )
}

/** The open roll call: the screen that matters during the emergency itself. */
function ActiveCheck({ check }: { check: Check }) {
  const qc = useQueryClient()

  const mark = useMutation({
    mutationFn: ({ child, accounted }: { child: CheckChild; accounted: boolean }) =>
      api(`/api/admin/emergency-check/${check.id}/children/${child.child_id}`, {
        method: 'POST',
        body: { accounted },
      }),
    // Optimistic: during an evacuation a tick that waits on the network reads
    // as "didn't take", and the second tap undoes the first.
    onMutate: async ({ child, accounted }) => {
      await qc.cancelQueries({ queryKey: KEY })
      qc.setQueryData<Overview>(KEY, (old) => {
        if (!old?.active) return old
        const children = old.active.children.map((c) =>
          c.child_id === child.child_id
            ? {
                ...c,
                accounted_at: accounted ? new Date().toISOString() : null,
                accounted_by: accounted ? 'You' : null,
              }
            : c,
        )
        const accountedN = children.filter((c) => c.accounted_at).length
        const releasedN = children.filter((c) => !c.accounted_at && c.released_at).length
        return {
          ...old,
          active: {
            ...old.active,
            children,
            accounted: accountedN,
            released: releasedN,
            missing: children.length - accountedN - releasedN,
          },
        }
      })
    },
    onError: (e, { child }) =>
      notifyError(
        `${child.name} was not saved — tap again`,
        e instanceof ApiError ? e.message : undefined,
      ),
    onSettled: () => void qc.invalidateQueries({ queryKey: KEY }),
  })

  const end = useMutation({
    mutationFn: () =>
      api(`/api/admin/emergency-check/${check.id}/end`, { method: 'POST' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }),
    onError: (e) =>
      notifyError('Could not close the check', e instanceof ApiError ? e.message : undefined),
  })

  const closeCheck = async () => {
    const ok = await confirmAction(
      'Close this check?',
      check.missing > 0
        ? `${check.missing} ${check.missing === 1 ? 'child is' : 'children are'} still not accounted for. The check will be saved as it stands.`
        : 'Everyone is accounted for. The check will be saved to the history.',
      'Close check',
    )
    if (ok) end.mutate()
  }

  return (
    <>
      <Card
        className={`mb-6 border-l-4 p-5 ${check.missing > 0 ? 'border-coral-500' : 'border-leaf-500'}`}
      >
        <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="flex items-center gap-2 font-extrabold text-coral-700">
              <Siren className="size-5" strokeWidth={2.4} />
              Emergency check in progress
            </p>
            <p className="text-[0.85rem] font-semibold text-ink-500">
              {check.note ? `${check.note} · ` : ''}
              Started {time(check.started_at)}
              {check.started_by ? ` by ${check.started_by}` : ''}
            </p>
          </div>
          <Button variant="outline" size="sm" loading={end.isPending} onClick={closeCheck}>
            Close check
          </Button>
        </div>
        <Summary check={check} />
      </Card>
      <ChildList
        check={check}
        onToggle={(child) => mark.mutate({ child, accounted: !child.accounted_at })}
      />
    </>
  )
}

function StartCheck() {
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const start = useMutation({
    mutationFn: () =>
      api('/api/admin/emergency-check', { method: 'POST', body: { note: note.trim() } }),
    onSuccess: () => {
      setNote('')
      void qc.invalidateQueries({ queryKey: KEY })
    },
    onError: (e) => {
      // 409: another admin started one a moment ago — join theirs.
      if (e instanceof ApiError && e.status === 409) {
        void qc.invalidateQueries({ queryKey: KEY })
        return
      }
      notifyError('Could not start the check', e instanceof ApiError ? e.message : undefined)
    },
  })
  return (
    <Card className="mb-8 flex flex-col gap-4 p-5">
      <div>
        <p className="font-extrabold text-ink-800">Start a roll call</p>
        <p className="text-[0.88rem] font-medium text-ink-500">
          Lists every child who is in the building right now — checked in and
          not yet picked up. Anyone with admin access can tick children off from
          their own phone; everyone sees the same list.
        </p>
      </div>
      <Field
        label="What is it? (optional)"
        placeholder="Fire drill, evacuation…"
        maxLength={200}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div>
        <Button variant="coral" size="lg" loading={start.isPending} onClick={() => start.mutate()}>
          <Siren className="size-5" strokeWidth={2.4} />
          Start emergency check
        </Button>
      </div>
    </Card>
  )
}

/** A closed check, read back as the drill record. */
function PastCheckDetail({ id, onBack }: { id: number; onBack: () => void }) {
  const { data, isPending } = useQuery({
    queryKey: [...KEY, id],
    queryFn: () => api<Check>(`/api/admin/emergency-check/${id}`),
  })
  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-4">
        <ArrowLeft className="size-4" /> All checks
      </Button>
      {isPending || !data ? (
        <Skeleton className="h-64" />
      ) : (
        <>
          <h1 className="mb-1 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
            {data.note || 'Emergency check'}
          </h1>
          <p className="mb-6 text-[0.95rem] font-medium text-ink-500">
            {dateTime(data.started_at)}
            {data.started_by ? ` · started by ${data.started_by}` : ''}
            {data.ended_at ? ` · closed ${time(data.ended_at)}` : ''}
            {data.ended_by ? ` by ${data.ended_by}` : ''}
          </p>
          <Card className="mb-6 p-5">
            <Summary check={data} />
          </Card>
          <ChildList check={data} />
        </>
      )}
    </div>
  )
}

export function AdminEmergencyCheck() {
  const qc = useQueryClient()
  const [viewing, setViewing] = useState<number | null>(null)
  const { data, isPending } = useQuery({
    queryKey: KEY,
    queryFn: () => api<Overview>('/api/admin/emergency-check'),
    // The stream is the fast path; this catches a dropped connection, which
    // is exactly what a phone walking out of the building does.
    refetchInterval: 10_000,
  })
  useEmergencyStream(() => void qc.invalidateQueries({ queryKey: KEY }))

  if (viewing !== null) {
    return <PastCheckDetail id={viewing} onBack={() => setViewing(null)} />
  }

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <h1 className="mb-6 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Emergency check
      </h1>

      {isPending || !data ? (
        <Skeleton className="h-64" />
      ) : data.active ? (
        <ActiveCheck key={data.active.id} check={data.active} />
      ) : (
        <>
          <StartCheck />
          <h2 className="mb-3 text-[1.1rem] font-extrabold text-ink-900">Past checks</h2>
          {data.recent.length === 0 ? (
            <EmptyState
              icon={<Siren className="size-7" strokeWidth={1.8} />}
              title="No checks yet"
              body="Every check you close is kept here, with who was found and when."
            />
          ) : (
            <Card className="divide-y divide-canvas-200 overflow-hidden">
              {data.recent.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setViewing(r.id)}
                  className="flex w-full flex-wrap items-center justify-between gap-2 px-5 py-3 text-left hover:bg-canvas-100"
                >
                  <div>
                    <p className="font-bold text-ink-900">{r.note || 'Emergency check'}</p>
                    <p className="text-[0.82rem] font-semibold text-ink-500">
                      {dateTime(r.started_at)}
                      {r.started_by ? ` · ${r.started_by}` : ''}
                    </p>
                  </div>
                  <Pill status={r.missing === 0 ? 'leaf' : 'coral'}>
                    {r.missing === 0
                      ? `All ${r.total} accounted for`
                      : `${r.missing} of ${r.total} not found`}
                  </Pill>
                </button>
              ))}
            </Card>
          )}
        </>
      )}
    </div>
  )
}
