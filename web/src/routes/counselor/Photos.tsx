import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, ImagePlus, Trash2 } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { downscale } from '@/lib/image'
import { Button, Card, EmptyState, Skeleton } from '@/components/ui'

type RosterChild = { id: number; name: string }
type RosterSchool = { school: string; attending: RosterChild[] }

type Photo = {
  id: number
  photo_date: string
  caption: string | null
  url: string | null
  children: string[]
}

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

/**
 * Counselor photos: shoot, tag, post.
 *
 * Tagging is required rather than optional. An untagged photo reaches no
 * parent — it would sit in storage looking uploaded while nobody could see it,
 * which is the worst of both outcomes.
 */
export function CounselorPhotos() {
  const qc = useQueryClient()
  const date = isoToday()
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [tagged, setTagged] = useState<number[]>([])
  const [caption, setCaption] = useState('')
  const [error, setError] = useState('')

  const { data: roster } = useQuery({
    queryKey: ['counselor', 'roster', date],
    queryFn: () => api<RosterSchool[]>(`/api/counselor/roster?date=${date}`),
  })

  // The list has its own scope, separate from `date` above: posting is always
  // about today, but "what have I posted" is usually not. Left on today the
  // section was empty on any day this counselor had not posted yet, which
  // reads as broken rather than as a quiet day.
  const [scope, setScope] = useState<'today' | 'all'>('today')

  const { data: photos, isPending } = useQuery({
    queryKey: ['counselor', 'photos', scope === 'all' ? 'all' : date],
    queryFn: () =>
      api<Photo[]>(
        `/api/counselor/photos?date=${scope === 'all' ? 'all' : date}`,
      ),
  })

  const children = (roster ?? []).flatMap((s) => s.attending)

  const reset = () => {
    setFile(null)
    setTagged([])
    setCaption('')
    setError('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) return
      const form = new FormData()
      form.append('file', await downscale(file))
      form.append('date', date)
      if (caption.trim()) form.append('caption', caption.trim())
      tagged.forEach((id) => form.append('child_ids', String(id)))
      return api('/api/counselor/photos', { method: 'POST', body: form })
    },
    onSuccess: () => {
      reset()
      void qc.invalidateQueries({ queryKey: ['counselor', 'photos'] })
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : 'Could not upload that photo.',
      ),
  })

  const remove = useMutation({
    mutationFn: (id: number) =>
      api(`/api/counselor/photos/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['counselor', 'photos'] }),
  })

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <h1 className="mb-4 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Photos
      </h1>

      <Card className="mb-5 p-4">
        {/* The native input's own button/label text comes from the browser's
            locale, not this app's — a Spanish OS shows "Seleccionar
            archivo" no matter what language the rest of the screen is in.
            Hiding it and driving everything from `file` state keeps the
            wording ours on any device. */}
        <div className="mb-3 flex items-center gap-3">
          <label className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-grape-500 px-4 py-2 text-[0.88rem] font-bold text-white active:bg-grape-600">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              capture="environment"
              aria-label="Choose a photo"
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null)
                setError('')
              }}
              className="hidden"
            />
            Choose photo
          </label>
          <span className="min-w-0 flex-1 truncate text-[0.88rem] font-semibold text-ink-600">
            {file ? file.name : 'No file chosen'}
          </span>
        </div>

        {file && (
          <>
            <p className="mb-2 text-[0.8rem] font-extrabold tracking-wide text-ink-400 uppercase">
              Who is in it?
            </p>
            {children.length === 0 ? (
              <p className="mb-3 text-[0.85rem] font-medium text-ink-500">
                Nobody is on today's roster, so there is no one to tag yet.
              </p>
            ) : (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {children.map((c) => {
                  const on = tagged.includes(c.id)
                  return (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={on}
                      onClick={() =>
                        setTagged((prev) =>
                          on ? prev.filter((x) => x !== c.id) : [...prev, c.id],
                        )
                      }
                      className={`rounded-full px-3 py-1.5 text-[0.82rem] font-bold transition ${
                        on
                          ? 'bg-grape-500 text-white'
                          : 'bg-canvas-100 text-ink-600'
                      }`}
                    >
                      {c.name}
                    </button>
                  )
                })}
              </div>
            )}

            <input
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              placeholder="Caption (optional)"
              aria-label="Caption"
              className="mb-3 w-full rounded-2xl border border-canvas-200 px-4 py-2.5 text-[0.9rem] font-medium text-ink-900 outline-none focus:border-grape-500"
            />

            {error && (
              <p className="mb-2 text-[0.82rem] font-semibold text-berry-600">
                {error}
              </p>
            )}

            <div className="flex gap-2">
              <Button
                loading={upload.isPending}
                disabled={tagged.length === 0}
                onClick={() => upload.mutate()}
              >
                <ImagePlus className="size-4" strokeWidth={2.4} />
                Post photo
              </Button>
              <Button variant="outline" onClick={reset}>
                Cancel
              </Button>
            </div>
            {tagged.length === 0 && children.length > 0 && (
              <p className="mt-2 text-[0.8rem] font-medium text-ink-400">
                Tag at least one child — that's who gets to see it.
              </p>
            )}
          </>
        )}
      </Card>

      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-[0.95rem] font-extrabold text-ink-700">
          {scope === 'all' ? 'Everything you have posted' : 'Posted today'}
        </h2>
        <button
          type="button"
          onClick={() => setScope(scope === 'all' ? 'today' : 'all')}
          className="rounded-full border border-canvas-200 px-3 py-1.5 text-[0.78rem] font-bold text-ink-600 hover:bg-canvas-100"
        >
          {scope === 'all' ? 'Just today' : 'Show all'}
        </button>
      </div>

      {isPending ? (
        <Skeleton className="h-40" />
      ) : !photos?.length ? (
        <Card>
          <EmptyState
            icon={<Camera className="size-7" strokeWidth={1.8} />}
            title={scope === 'all' ? 'You have not posted any' : 'Nothing posted today'}
            body={
              scope === 'all'
                ? 'Photos you post show up here, and in the galleries of the families you tag.'
                : 'Nothing yet today. Tap Show all to see your earlier photos.'
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-3">
          {photos.map((p) => (
            <Card key={p.id} className="overflow-hidden">
              {p.url && (
                <img
                  src={p.url}
                  alt={p.caption ?? `Photo of ${p.children.join(', ')}`}
                  className="aspect-square w-full object-cover"
                />
              )}
              <div className="flex items-start gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.82rem] font-bold text-ink-700">
                    {p.children.join(', ')}
                  </p>
                  {p.caption && (
                    <p className="truncate text-[0.78rem] font-medium text-ink-500">
                      {p.caption}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  aria-label="Delete photo"
                  onClick={() => remove.mutate(p.id)}
                  className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-berry-50 hover:text-berry-500"
                >
                  <Trash2 className="size-4" strokeWidth={2.1} />
                </button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
