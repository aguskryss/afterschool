import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Archive,
  Check,
  DoorOpen,
  Pencil,
  RotateCcw,
  Trash2,
  X,
} from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Card, EmptyState, Pill, Skeleton } from '@/components/ui'

type Room = {
  id: number
  name: string
  capacity_hint: number | null
  sort_order: number
  active: boolean
  care_rule_count: number
}

/**
 * What a PUT may carry. `capacity_hint` widens to a string because the input
 * hands over text and the endpoint parses it — coercing here would turn an
 * empty field into 0 rather than "no hint".
 */
type RoomPatch = {
  id: number
  name?: string
  capacity_hint?: string | number | null
  sort_order?: number
  active?: boolean
}

const INPUT =
  'h-10 rounded-full border-2 border-canvas-200 bg-white px-4 text-[0.9rem] font-semibold text-ink-800 outline-none focus:border-sky-500'

/**
 * The rooms children wait in between school and pickup.
 *
 * R7 of the daily-operations spec is explicit that this list is named by the
 * director rather than hardcoded: it differs per JCC, and the grade split that
 * fills each room moves with the headcount. So this screen only owns the names.
 * *Which* grades land in which room at which hour is the care-rules screen, and
 * *who staffs* them is the staff schedule — both downstream of this list, which
 * is why an empty one is worth saying out loud.
 */
export function AdminRooms() {
  const qc = useQueryClient()
  const [showArchived, setShowArchived] = useState(false)
  const [name, setName] = useState('')
  const [capacity, setCapacity] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const [error, setError] = useState('')

  const { data, isPending } = useQuery({
    queryKey: ['admin', 'rooms', showArchived],
    queryFn: () =>
      api<Room[]>(
        `/api/admin/rooms${showArchived ? '?include_archived=1' : ''}`,
      ),
  })

  function refresh() {
    void qc.invalidateQueries({ queryKey: ['admin', 'rooms'] })
  }

  function fail(e: unknown, fallback: string) {
    setError(e instanceof ApiError ? e.message : fallback)
  }

  const add = useMutation({
    mutationFn: () =>
      api<Room>('/api/admin/rooms', {
        method: 'POST',
        body: { name, capacity_hint: capacity || null },
      }),
    onSuccess: () => {
      setName('')
      setCapacity('')
      setError('')
      refresh()
    },
    onError: (e) => fail(e, 'Could not add that room.'),
  })

  // The body is deliberately partial: the endpoint falls back to the row's
  // current values for anything the body leaves out, so "restore" can send
  // nothing but `active` without nulling the name or the capacity.
  const save = useMutation({
    mutationFn: ({ id, ...body }: RoomPatch) =>
      api<Room>(`/api/admin/rooms/${id}`, { method: 'PUT', body }),
    onSuccess: () => {
      setEditing(null)
      setError('')
      refresh()
    },
    onError: (e) => fail(e, 'Could not save that room.'),
  })

  // Retiring a room is archiving it, never deleting: care rules point at rooms
  // with ON DELETE CASCADE, so a delete would take the grade ranges with it.
  // The real delete below exists for typos and refuses anything in use.
  const destroy = useMutation({
    mutationFn: (id: number) =>
      api<{ deleted: boolean }>(`/api/admin/rooms/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setError('')
      refresh()
    },
    onError: (e) => fail(e, 'Could not delete that room.'),
  })

  const rooms = data ?? []

  return (
    <div className="mx-auto w-full max-w-4xl">
      <h1 className="mb-2 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Rooms
      </h1>
      <p className="mb-6 max-w-2xl text-[0.95rem] font-medium text-ink-500">
        The spaces children wait in between school and pickup — Ocean, Gym,
        Playground, and any other room you use. Which grades go where, and at
        what hour, is set on the care rules screen.
      </p>

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[0.75rem] font-bold text-ink-500">Room</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ocean Room"
              aria-label="Room name"
              className={INPUT}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && name.trim()) add.mutate()
              }}
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[0.75rem] font-bold text-ink-500">
              Capacity
            </span>
            <input
              value={capacity}
              onChange={(e) => setCapacity(e.target.value)}
              inputMode="numeric"
              placeholder="optional"
              aria-label="Capacity hint"
              className={`${INPUT} w-28`}
            />
          </label>
          <Button
            size="sm"
            disabled={!name.trim()}
            loading={add.isPending}
            onClick={() => add.mutate()}
          >
            Add room
          </Button>
        </div>
        {error && (
          <p className="mt-2 text-[0.85rem] font-bold text-berry-600">{error}</p>
        )}
      </Card>

      {isPending ? (
        <Skeleton className="h-40" />
      ) : rooms.length === 0 ? (
        <EmptyState
          icon={<DoorOpen className="size-7" strokeWidth={1.8} />}
          title="No rooms yet"
          body="Add the rooms your afternoon uses. Nothing downstream — care rules, staff assignments, or a counselor's day — can point anywhere until they exist."
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {rooms.map((room) =>
            editing === room.id ? (
              <RoomEditor
                key={room.id}
                room={room}
                saving={save.isPending}
                onCancel={() => setEditing(null)}
                onSave={(values) => save.mutate({ id: room.id, ...values })}
              />
            ) : (
              <li
                key={room.id}
                className="flex flex-wrap items-center gap-2 rounded-2xl bg-white px-4 py-3 shadow-soft"
              >
                <span
                  className={`font-bold ${room.active ? 'text-ink-900' : 'text-ink-400 line-through'}`}
                >
                  {room.name}
                </span>
                {room.capacity_hint !== null && (
                  <Pill status="neutral">holds ~{room.capacity_hint}</Pill>
                )}
                {/* What this room is load-bearing for, said before anyone
                    archives it: care rules point here by id. */}
                {room.care_rule_count > 0 && (
                  <Pill status="leaf">
                    {room.care_rule_count} care{' '}
                    {room.care_rule_count === 1 ? 'rule' : 'rules'}
                  </Pill>
                )}
                {!room.active && <Pill status="neutral">Archived</Pill>}

                <div className="ms-auto flex items-center gap-1">
                  <button
                    type="button"
                    aria-label={`Edit ${room.name}`}
                    onClick={() => {
                      setEditing(room.id)
                      setError('')
                    }}
                    className="rounded-full p-1.5 text-ink-400 hover:bg-canvas-100 hover:text-ink-700"
                  >
                    <Pencil className="size-4" strokeWidth={2.2} />
                  </button>
                  {room.active ? (
                    <button
                      type="button"
                      aria-label={`Archive ${room.name}`}
                      onClick={() =>
                        save.mutate({ id: room.id, active: false })
                      }
                      className="rounded-full p-1.5 text-ink-400 hover:bg-berry-50 hover:text-berry-600"
                    >
                      <Archive className="size-4" strokeWidth={2.2} />
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        aria-label={`Restore ${room.name}`}
                        onClick={() =>
                          save.mutate({ id: room.id, active: true })
                        }
                        className="rounded-full p-1.5 text-ink-400 hover:bg-leaf-50 hover:text-leaf-600"
                      >
                        <RotateCcw className="size-4" strokeWidth={2.2} />
                      </button>
                      {/* Only offered once archived, and the endpoint still
                          refuses a room any care rule points at. */}
                      <button
                        type="button"
                        aria-label={`Delete ${room.name} for good`}
                        onClick={() => destroy.mutate(room.id)}
                        className="rounded-full p-1.5 text-ink-400 hover:bg-berry-50 hover:text-berry-600"
                      >
                        <Trash2 className="size-4" strokeWidth={2.2} />
                      </button>
                    </>
                  )}
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setShowArchived((v) => !v)}
        className="mt-4 text-[0.85rem] font-bold text-ink-500 underline decoration-canvas-200 underline-offset-4 hover:text-ink-700"
      >
        {showArchived ? 'Hide archived rooms' : 'Show archived rooms'}
      </button>
    </div>
  )
}

/**
 * The inline edit row. Order is exposed because two rooms sharing a number fall
 * back to alphabetical, which is the right default for a list this short — but a
 * director who wants Ocean above Gym should not have to rename anything.
 */
function RoomEditor({
  room,
  saving,
  onCancel,
  onSave,
}: {
  room: Room
  saving: boolean
  onCancel: () => void
  onSave: (values: {
    name: string
    capacity_hint: string | null
    sort_order: number
  }) => void
}) {
  const [name, setName] = useState(room.name)
  const [capacity, setCapacity] = useState(
    room.capacity_hint === null ? '' : String(room.capacity_hint),
  )
  const [order, setOrder] = useState(String(room.sort_order))

  function submit() {
    if (!name.trim()) return
    onSave({
      name,
      capacity_hint: capacity || null,
      sort_order: Number(order) || 100,
    })
  }

  return (
    <li className="flex flex-wrap items-end gap-2 rounded-2xl bg-canvas-100 px-4 py-3">
      <label className="flex flex-col gap-1">
        <span className="text-[0.75rem] font-bold text-ink-500">Room</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-label="Room name"
          className={INPUT}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
            if (e.key === 'Escape') onCancel()
          }}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[0.75rem] font-bold text-ink-500">Capacity</span>
        <input
          value={capacity}
          onChange={(e) => setCapacity(e.target.value)}
          inputMode="numeric"
          placeholder="optional"
          aria-label="Capacity hint"
          className={`${INPUT} w-28`}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[0.75rem] font-bold text-ink-500">Order</span>
        <input
          value={order}
          onChange={(e) => setOrder(e.target.value)}
          inputMode="numeric"
          aria-label="Sort order"
          className={`${INPUT} w-24`}
        />
      </label>
      <div className="ms-auto flex items-center gap-1">
        <Button size="sm" loading={saving} onClick={submit}>
          <Check className="size-4" strokeWidth={2.6} />
          Save
        </Button>
        <button
          type="button"
          aria-label="Cancel"
          onClick={onCancel}
          className="rounded-full p-1.5 text-ink-400 hover:bg-white hover:text-ink-700"
        >
          <X className="size-4" strokeWidth={2.4} />
        </button>
      </div>
    </li>
  )
}
