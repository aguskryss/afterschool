import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { CalendarOff, Car, Check, ChevronRight, Users } from 'lucide-react'
import { api } from '@/lib/api'
import { hasModule, readSession } from '@/lib/auth'
import { stateOn, todayIso, type Child } from '@/lib/parent'
import { Avatar, Button, Card, EmptyState, Pill, Skeleton } from '@/components/ui'
import { AuthorizedPickup } from '@/components/AuthorizedPickup'
import { PushPrompt } from '@/components/PushPrompt'


function greeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

/**
 * Parent home.
 *
 * The old screen stacked a full-width "I'm here to pick up <name>" button
 * inside every child card, so a family with three kids scrolled through three
 * near-identical screens to do one thing. Here the day's status leads, and
 * pickup is a single action that asks *who* only when there's a choice.
 */
export function ParentHome() {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const session = readSession()
  const [picked, setPicked] = useState<number[]>([])

  const { data: children, isPending } = useQuery({
    queryKey: ['parent', 'children'],
    queryFn: () => api<Child[]>('/api/parent/children'),
  })

  const attending = useMemo(
    () => (children ?? []).filter((c) => stateOn(c, todayIso()) === 'attending'),
    [children],
  )

  const pickup = useMutation({
    mutationFn: (ids: number[]) =>
      Promise.all(
        ids.map((child_id) =>
          api('/api/parent/pickup', { method: 'POST', body: { child_id } }),
        ),
      ),
    onSuccess: () => {
      setPicked([])
      void qc.invalidateQueries({ queryKey: ['parent'] })
    },
  })

  const firstName = session?.name?.split(' ')[0] ?? ''
  const selection = picked.length ? picked : attending.map((c) => c.id)

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      {/* Above the fold on the screen a parent opens first. Buried on the
          Account tab, nobody who just installed the app ever found it. */}
      <PushPrompt />

      <header className="mb-6">
        <p className="text-[0.9rem] font-semibold text-ink-400">
          {new Date().toLocaleDateString('en-US', {
            weekday: 'long',
            month: 'long',
            day: 'numeric',
          })}
        </p>
        <h1 className="mt-1 text-[1.75rem] font-extrabold leading-tight tracking-tight text-ink-900">
          {greeting()}
          {firstName ? `, ${firstName}` : ''}
        </h1>
      </header>

      {isPending ? (
        <div className="flex flex-col gap-3">
          <Skeleton className="h-40" />
          <Skeleton className="h-28" />
        </div>
      ) : !children?.length ? (
        <Card>
          <EmptyState
            icon={<Users className="size-7" strokeWidth={1.8} />}
            title="No children yet"
            body="As soon as the program adds your child, they'll show up right here."
          />
        </Card>
      ) : (
        <>
          {/* The one urgent action, and only when someone is actually there today. */}
          {attending.length > 0 && (
            <Card className="mb-6 overflow-hidden">
              <div className="flex items-center gap-3 bg-coral-50 px-5 py-3.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-coral-500 text-white">
                  <Car className="size-5" strokeWidth={2.2} />
                </span>
                <div>
                  <p className="font-extrabold text-coral-700">Pickup time</p>
                  <p className="text-[0.88rem] font-medium text-coral-700/75">
                    Tap when you pull up and we&apos;ll bring them out.
                  </p>
                </div>
              </div>

              <div className="p-5">
                {/* Who to pick up — shown only when there's more than one option. */}
                {attending.length > 1 && (
                  <div className="mb-4 flex flex-wrap gap-2">
                    {attending.map((c) => {
                      const on = selection.includes(c.id)
                      return (
                        <button
                          key={c.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() =>
                            setPicked((prev) => {
                              const base = prev.length
                                ? prev
                                : attending.map((a) => a.id)
                              return base.includes(c.id)
                                ? base.filter((id) => id !== c.id)
                                : [...base, c.id]
                            })
                          }
                          className={`inline-flex items-center gap-2.5 rounded-full border-2 py-2 pr-4 pl-2.5 text-[0.92rem] font-bold transition ${
                            on
                              ? 'border-sky-500 bg-sky-50 text-sky-700'
                              : 'border-canvas-200 bg-white text-ink-400'
                          }`}
                        >
                          <span className={on ? '' : 'opacity-45 grayscale'}>
                            <Avatar name={c.name} id={c.id} size="sm" />
                          </span>
                          {c.name.split(' ')[0]}
                          {on && (
                            <Check
                              className="size-4 text-sky-500"
                              strokeWidth={3.5}
                            />
                          )}
                        </button>
                      )
                    })}
                  </div>
                )}

                <Button
                  variant="coral"
                  size="lg"
                  full
                  loading={pickup.isPending}
                  disabled={selection.length === 0}
                  onClick={() => pickup.mutate(selection)}
                >
                  {pickup.isSuccess ? (
                    <>
                      <Check className="size-5" strokeWidth={3} />
                      We&apos;ll be right out
                    </>
                  ) : (
                    "I'm here"
                  )}
                </Button>

                {pickup.isError && (
                  <p role="alert" className="mt-2 text-sm text-berry-600">
                    {pickup.error instanceof Error
                      ? pickup.error.message
                      : 'Could not notify the team.'}
                  </p>
                )}
              </div>
            </Card>
          )}

          <h2 className="mb-3 px-1 text-[0.95rem] font-extrabold text-ink-700">
            My kids
          </h2>

          <div className="flex flex-col gap-3">
            {children.map((child) => {
              const state = stateOn(child, todayIso())
              return (
                <Card key={child.id} className="p-4">
                  <div className="flex items-center gap-3.5">
                    <Avatar name={child.name} id={child.id} size="lg" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[1.05rem] font-extrabold text-ink-900">
                        {child.name}
                      </p>
                      <p className="mt-0.5 truncate text-[0.88rem] font-medium text-ink-400">
                        {child.school}
                      </p>
                    </div>
                    {state === 'attending' ? (
                      <Pill status="leaf">Here today</Pill>
                    ) : state === 'absent' ? (
                      <Pill status="berry">Absent</Pill>
                    ) : (
                      <Pill>Day off</Pill>
                    )}
                  </div>

                  {/* Only actions that actually do something. Recurring
                      absences and make-up classes aren't built in this app
                      yet — showing dead buttons for them implied features
                      that don't exist. They come back with their flows. */}
                  {hasModule('absences') && (
                  <div className="mt-3.5 border-t border-canvas-200 pt-3.5">
                    <button
                      type="button"
                      onClick={() => navigate('/calendar')}
                      className="flex w-full items-center gap-2.5 rounded-2xl px-2 py-2 text-[0.85rem] font-bold text-ink-600 transition-colors hover:bg-canvas-100 active:bg-canvas-200"
                    >
                      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-berry-50 text-berry-500">
                        <CalendarOff className="size-[1.15rem]" strokeWidth={2.2} />
                      </span>
                      Report an absence
                      <ChevronRight
                        className="ml-auto size-4 text-ink-300"
                        strokeWidth={2.4}
                      />
                    </button>
                  </div>
                  )}

                  {hasModule('secure_pickup') && (
                    <AuthorizedPickup
                      childId={child.id}
                      siblings={children
                        .filter((c) => c.id !== child.id)
                        .map((c) => c.name)}
                    />
                  )}
                </Card>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
