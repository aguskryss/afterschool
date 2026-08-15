import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Trash2, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { Button, Card, EmptyState, Skeleton } from '@/components/ui'
import { downscale } from '@/lib/image'
import { matchesName } from '@/lib/roster'

type Photo = {
  id: number
  photo_date: string
  caption: string | null
  url: string | null
  children: string[]
  uploaded_by_name: string | null
}

function isoToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${`${d.getMonth() + 1}`.padStart(2, '0')}-${`${d.getDate()}`.padStart(2, '0')}`
}

type ParentRow = {
  id: number
  name: string
  children: { id: number; name: string; school: string; active: number }[]
}

/**
 * Posting a photo as an administrator.
 *
 * The server has always allowed this — /api/counselor/photos takes 'admin' as
 * well, and gives an admin the whole roster to tag from rather than one
 * counselor's schools. There was simply no way to reach it from the admin
 * screens, so in practice only counselors could post.
 *
 * The endpoint keeps its counselor-shaped path because renaming it would break
 * the counselor client for a cosmetic gain.
 *
 * WHY A SEARCH BOX AND NOT A LIST OF CHIPS. A counselor tags from the handful
 * of children on their own roster today; an admin is choosing from every child
 * in the JCC, which at the one running this is 156. A wall of 156 chips is not
 * a picker.
 */
function Uploader({ date, onDone }: { date: string; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [tagged, setTagged] = useState<number[]>([])
  const [caption, setCaption] = useState('')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')

  // Same key the People and Conversations screens use, so this is served from
  // cache rather than being a third request for the same roster.
  const { data: parents } = useQuery({
    queryKey: ['admin', 'parents'],
    queryFn: () => api<ParentRow[]>('/api/admin/parents'),
  })

  const children = useMemo(
    () =>
      (parents ?? [])
        .flatMap((p) => p.children.map((c) => ({ ...c, parent: p.name })))
        .filter((c) => c.active)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [parents],
  )

  const matches = useMemo(() => {
    if (!query.trim()) return []
    return children.filter((c) => matchesName(c.name, query)).slice(0, 8)
  }, [children, query])

  const chosen = children.filter((c) => tagged.includes(c.id))

  const reset = () => {
    setFile(null)
    setTagged([])
    setCaption('')
    setQuery('')
    setError('')
    if (fileRef.current) fileRef.current.value = ''
  }

  const upload = useMutation({
    mutationFn: async () => {
      if (!file) return
      const form = new FormData()
      // Downscaled in the browser, same as the counselor path: an 8 MB phone
      // photo is refused by the server and would be a slow upload anyway.
      form.append('file', await downscale(file))
      form.append('date', date)
      if (caption.trim()) form.append('caption', caption.trim())
      tagged.forEach((id) => form.append('child_ids', String(id)))
      return api('/api/counselor/photos', { method: 'POST', body: form })
    },
    onSuccess: () => {
      reset()
      onDone()
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : 'Could not upload that photo.',
      ),
  })

  return (
    <Card className="mb-5 p-4">
      <p className="mb-3 font-extrabold text-ink-800">Post a photo</p>

      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        aria-label="Choose a photo"
        onChange={(e) => {
          setFile(e.target.files?.[0] ?? null)
          setError('')
        }}
        className="mb-3 block w-full text-[0.88rem] font-semibold text-ink-600 file:mr-3 file:rounded-full file:border-0 file:bg-grape-500 file:px-4 file:py-2 file:font-bold file:text-white"
      />

      {file && (
        <>
          <p className="mb-2 text-[0.8rem] font-extrabold tracking-wide text-ink-400 uppercase">
            Who is in it?
          </p>

          {chosen.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {chosen.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() =>
                    setTagged((prev) => prev.filter((x) => x !== c.id))
                  }
                  className="inline-flex items-center gap-1.5 rounded-full bg-grape-500 px-3 py-1.5 text-[0.82rem] font-bold text-white"
                >
                  {c.name}
                  <X className="size-3.5" strokeWidth={2.6} />
                </button>
              ))}
            </div>
          )}

          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search a child by name"
            aria-label="Search a child to tag"
            className="mb-2 w-full rounded-2xl border-2 border-canvas-200 px-4 py-2 text-[0.88rem] font-medium outline-none focus:border-grape-500"
          />
          {matches.length > 0 && (
            <ul className="mb-3 flex flex-col divide-y divide-canvas-200 overflow-hidden rounded-2xl border border-canvas-200">
              {matches.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => {
                      setTagged((prev) =>
                        prev.includes(c.id) ? prev : [...prev, c.id],
                      )
                      setQuery('')
                    }}
                    className="flex w-full items-baseline justify-between gap-3 px-3 py-2 text-left hover:bg-canvas-100"
                  >
                    <span className="truncate text-[0.88rem] font-bold text-ink-800">
                      {c.name}
                    </span>
                    <span className="shrink-0 text-[0.76rem] font-semibold text-ink-400">
                      {c.school}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <input
            value={caption}
            onChange={(e) => setCaption(e.target.value)}
            placeholder="Caption (optional)"
            aria-label="Caption"
            className="mb-3 w-full rounded-2xl border-2 border-canvas-200 px-4 py-2 text-[0.88rem] font-medium outline-none focus:border-grape-500"
          />

          {error && (
            <p role="alert" className="mb-3 text-sm font-medium text-berry-600">
              {error}
            </p>
          )}

          <div className="flex gap-2">
            <Button
              // Tagging is what decides who can see it, so an untagged photo
              // would be uploaded and then visible to nobody.
              disabled={tagged.length === 0}
              loading={upload.isPending}
              onClick={() => upload.mutate()}
            >
              Post to {tagged.length || 'no'}{' '}
              {tagged.length === 1 ? 'family' : 'families'}
            </Button>
            <Button variant="ghost" onClick={reset}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </Card>
  )
}

/**
 * Every photo posted on one day, whoever posted it.
 *
 * Counselors see only their own uploads; an admin sees the lot. Moderating a
 * photo of somebody's child has to be possible without first working out
 * which counselor put it up.
 */
export function AdminPhotos() {
  const qc = useQueryClient()
  // Opens on everything, not on today.
  //
  // Photos are not posted every day, so a screen scoped to today was empty
  // most of the time — and an empty grid beside a date picker gives no clue
  // which days have anything in them. "All" is the view that is never blank
  // for the wrong reason; the day filter is still there for the times you know
  // the date you want.
  const [date, setDate] = useState<string>('all')
  const showingAll = date === 'all'

  const { data: photos, isPending } = useQuery({
    queryKey: ['admin', 'photos', date],
    queryFn: () => api<Photo[]>(`/api/counselor/photos?date=${date}`),
  })

  // The server caps a page; say so rather than presenting a truncated year as
  // if it were the whole thing.
  const capped = (photos?.length ?? 0) >= 200

  const remove = useMutation({
    mutationFn: (id: number) =>
      api(`/api/counselor/photos/${id}`, { method: 'DELETE' }),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: ['admin', 'photos', date] }),
  })

  return (
    <div className="mx-auto w-full max-w-[1800px]">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-[1.75rem] font-extrabold tracking-tight text-ink-900">
          Photos
        </h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={showingAll}
            onClick={() => setDate('all')}
            className={`rounded-2xl px-4 py-2 text-[0.9rem] font-bold transition ${
              showingAll
                ? 'bg-grape-500 text-white'
                : 'border border-canvas-200 text-ink-600 hover:bg-canvas-100'
            }`}
          >
            All
          </button>
          <input
            type="date"
            value={showingAll ? '' : date}
            onChange={(e) => setDate(e.target.value || 'all')}
            aria-label="Filter by day"
            className={`rounded-2xl border px-4 py-2 text-[0.9rem] font-semibold text-ink-900 outline-none focus:border-grape-500 ${
              showingAll ? 'border-canvas-200' : 'border-grape-500'
            }`}
          />
        </div>
      </div>

      {/* "all" is a filter, never a date to file a photo under. Posting while
          that filter is on files under today, which is what someone uploading
          this afternoon's photos means. */}
      <Uploader
        date={showingAll ? isoToday() : date}
        onDone={() =>
          void qc.invalidateQueries({ queryKey: ['admin', 'photos'] })
        }
      />

      {isPending ? (
        <Skeleton className="h-64" />
      ) : !photos?.length ? (
        <Card>
          <EmptyState
            icon={<Camera className="size-7" strokeWidth={1.8} />}
            title={showingAll ? 'No photos yet' : 'Nothing on this day'}
            body={
              showingAll
                ? 'Post the first one above — parents see a photo as soon as their child is tagged in it.'
                : 'Nobody posted on this day. Switch to All to see everything.'
            }
          />
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4">
          {photos.map((p) => (
            <Card key={p.id} className="overflow-hidden">
              {p.url ? (
                <img
                  src={p.url}
                  alt={p.caption ?? `Photo of ${p.children.join(', ')}`}
                  loading="lazy"
                  className="aspect-square w-full object-cover"
                />
              ) : (
                <span className="flex aspect-square w-full items-center justify-center bg-canvas-100 text-[0.78rem] font-semibold text-ink-400">
                  Unavailable
                </span>
              )}
              <div className="flex items-start gap-2 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[0.82rem] font-bold text-ink-800">
                    {p.children.join(', ') || 'Nobody tagged'}
                  </p>
                  <p className="truncate text-[0.76rem] font-medium text-ink-400">
                    {/* The day is on the card only when the grid spans days —
                        with a date filter on it is already at the top and
                        repeating it on every tile is noise. */}
                    {showingAll && `${p.photo_date} · `}
                    by {p.uploaded_by_name ?? 'a removed account'}
                  </p>
                  {p.caption && (
                    <p className="truncate text-[0.76rem] font-medium text-ink-500">
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

      {capped && (
        <p className="mt-4 text-center text-[0.82rem] font-semibold text-ink-400">
          Showing the 200 most recent. Pick a day to see further back.
        </p>
      )}
    </div>
  )
}
