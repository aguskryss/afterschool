import { useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Camera, Trash2, X } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { confirmDelete } from '@/lib/confirm'
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
  /** Every photo in the same bulk upload shares this — the root photo's own
   *  id (sql/65). Used for the one-notification-per-batch dedup server-side;
   *  on its own it says nothing about whether this should display grouped. */
  album_id: number
  /** Set only when the uploader named this batch (sql/67) — that is what
   *  makes it a real, browsable album instead of a batch that merely
   *  happened to upload together. */
  album_name: string | null
}

/**
 * Photos ready to render, one entry per card.
 *
 * Only a NAMED album groups — `album_id` alone (every photo has one, even a
 * lone upload) says nothing about whether these were meant to be seen as one
 * post. An unnamed batch renders exactly like the individual photos it
 * looked like before bulk upload and albums existed.
 */
function groupForDisplay(photos: Photo[]): Photo[][] {
  const groups: Photo[][] = []
  const named = new Map<number, Photo[]>()
  for (const p of photos) {
    if (!p.album_name) {
      groups.push([p])
      continue
    }
    const existing = named.get(p.album_id)
    if (existing) {
      existing.push(p)
    } else {
      const group = [p]
      named.set(p.album_id, group)
      groups.push(group)
    }
  }
  return groups
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
 * Posting a photo — or a whole batch — as an administrator.
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
 *
 * WHY ONE TAG PASS FOR THE WHOLE BATCH. A bulk upload is one event shot
 * several times — pick-up, a birthday circle, a field trip — and every photo
 * in it is of the same kids by construction. Asking who is in each of twelve
 * photos individually is the one-by-one workflow this exists to replace; the
 * server groups everything selected here into one album (sql/65) and sends
 * one notification per family for the whole batch, not one per photo.
 */
function Uploader({ date, onDone }: { date: string; onDone: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [files, setFiles] = useState<File[]>([])
  const [tagged, setTagged] = useState<number[]>([])
  const [broadcast, setBroadcast] = useState(false)
  const [caption, setCaption] = useState('')
  const [isAlbum, setIsAlbum] = useState(false)
  const [albumName, setAlbumName] = useState('')
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

  // Tags every active child rather than sending anything separate: the
  // server already fans a push out to one parent per tagged child (see
  // counselor_upload_photo), so this is the one flip that makes "everyone"
  // reuse that exact path instead of needing a second notification route.
  const toggleBroadcast = () => {
    if (broadcast) {
      setBroadcast(false)
      setTagged([])
    } else {
      setBroadcast(true)
      setTagged(children.map((c) => c.id))
      setQuery('')
    }
  }

  const reset = () => {
    setFiles([])
    setTagged([])
    setBroadcast(false)
    setCaption('')
    setIsAlbum(false)
    setAlbumName('')
    setQuery('')
    setError('')
    if (fileRef.current) fileRef.current.value = ''
  }

  // A bulk upload is not automatically an album — most of the time it is just
  // a faster way to post several unrelated photos, and forcing every batch
  // into one grouped, named card would be wrong exactly as often as it was
  // right. Naming it is what turns it into a real album (sql/67); left
  // unchecked, the photos display as ordinary individual photos.
  const albumReady = !isAlbum || albumName.trim().length > 0

  const upload = useMutation({
    mutationFn: async () => {
      if (files.length === 0) return
      const form = new FormData()
      // Downscaled in the browser, same as the counselor path: an 8 MB phone
      // photo is refused by the server and would be a slow upload anyway.
      // One 'file' field per photo — the server reads the whole list as one
      // batch and groups it into one album (sql/65) either way, for the
      // notification; only a name makes it a browsable one (sql/67).
      const downscaled = await Promise.all(files.map(downscale))
      for (const f of downscaled) form.append('file', f)
      form.append('date', date)
      if (caption.trim()) form.append('caption', caption.trim())
      if (broadcast) form.append('broadcast', '1')
      if (isAlbum && albumName.trim()) form.append('album_name', albumName.trim())
      tagged.forEach((id) => form.append('child_ids', String(id)))
      return api('/api/counselor/photos', { method: 'POST', body: form })
    },
    onSuccess: () => {
      reset()
      onDone()
    },
    onError: (err) =>
      setError(
        err instanceof ApiError ? err.message : 'Could not upload those photos.',
      ),
  })

  return (
    <Card className="mb-5 p-4">
      <p className="mb-3 font-extrabold text-ink-800">Post photos</p>

      {/* The native input's own button/label text comes from the browser's
          locale, not this app's — a Spanish OS shows "Seleccionar
          archivos" no matter what language the rest of the screen is in.
          Hiding it and driving everything from `files` state keeps the
          wording ours on any device. `multiple`: picking several at once is
          the whole point — a school event is a dozen shots of the same kids,
          not one, and the server groups whatever lands in one request into
          a single album (sql/65). */}
      <div className="mb-3 flex items-center gap-3">
        <label className="inline-flex min-h-11 shrink-0 cursor-pointer items-center gap-2 rounded-full bg-grape-500 px-4 py-2 text-[0.88rem] font-bold text-white active:bg-grape-600">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            aria-label="Choose photos"
            onChange={(e) => {
              setFiles(Array.from(e.target.files ?? []))
              setError('')
            }}
            className="hidden"
          />
          Choose photos
        </label>
        <span className="min-w-0 flex-1 truncate text-[0.88rem] font-semibold text-ink-600">
          {files.length === 0
            ? 'No files chosen'
            : files.length === 1
              ? files[0].name
              : `${files.length} photos selected`}
        </span>
      </div>

      {files.length > 1 && (
        <div className="mb-3 rounded-2xl border-2 border-canvas-200 p-3">
          <label className="flex items-center gap-2 text-[0.88rem] font-semibold text-ink-700">
            <input
              type="checkbox"
              checked={isAlbum}
              onChange={(e) => {
                setIsAlbum(e.target.checked)
                if (!e.target.checked) setAlbumName('')
              }}
              className="size-4 accent-grape-500"
            />
            This is an album
          </label>
          {isAlbum ? (
            <input
              value={albumName}
              onChange={(e) => setAlbumName(e.target.value)}
              placeholder={'Album name, e.g. "Field trip to the zoo"'}
              aria-label="Album name"
              autoFocus
              className="mt-2 w-full rounded-2xl border-2 border-canvas-200 px-4 py-2 text-[0.88rem] font-medium outline-none focus:border-grape-500"
            />
          ) : (
            <p className="mt-1.5 text-[0.8rem] font-medium text-ink-400">
              Left unchecked, these post as {files.length} separate photos —
              not grouped, no shared name.
            </p>
          )}
        </div>
      )}

      {files.length > 0 && (
        <>
          <p className="mb-2 text-[0.8rem] font-extrabold tracking-wide text-ink-400 uppercase">
            {files.length === 1 ? 'Who is in it?' : 'Who is in these?'}
          </p>

          <label className="mb-3 flex items-center gap-2 text-[0.88rem] font-semibold text-ink-700">
            <input
              type="checkbox"
              checked={broadcast}
              disabled={children.length === 0}
              onChange={toggleBroadcast}
              className="size-4 accent-grape-500"
            />
            Send to every family ({children.length} active{' '}
            {children.length === 1 ? 'child' : 'children'})
          </label>

          {broadcast ? (
            <p className="mb-3 rounded-2xl border border-canvas-200 bg-canvas-100 px-3 py-2 text-[0.82rem] font-medium text-ink-600">
              Every family with an active child will see this photo — nobody
              needs to be tagged one by one.
            </p>
          ) : (
            <>
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
            </>
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
              // Tagging is what decides who can see it, so untagged photos
              // would be uploaded and then visible to nobody. A checked "This
              // is an album" with no name yet is not ready either — an
              // unnamed album is a contradiction, not a valid state to post.
              disabled={tagged.length === 0 || !albumReady}
              loading={upload.isPending}
              onClick={() => upload.mutate()}
            >
              {files.length > 1 ? `Post ${files.length} photos to ` : 'Post to '}
              {broadcast
                ? `all ${tagged.length} families`
                : `${tagged.length || 'no'} ${
                    tagged.length === 1 ? 'family' : 'families'
                  }`}
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

  // Every photo in the album, one DELETE each — there is no bulk-delete
  // endpoint, and adding one for a rare admin action would be more surface
  // than the parallel requests it replaces.
  const removeAlbum = useMutation({
    mutationFn: (ids: number[]) =>
      Promise.all(ids.map((id) => api(`/api/counselor/photos/${id}`, { method: 'DELETE' }))),
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
          {groupForDisplay(photos).map((album) => {
            const cover = album[0]
            const extra = album.length - 4
            return (
              <Card key={cover.id} className="overflow-hidden">
                {album.length === 1 ? (
                  cover.url ? (
                    <img
                      src={cover.url}
                      alt={cover.caption ?? `Photo of ${cover.children.join(', ')}`}
                      loading="lazy"
                      className="aspect-square w-full object-cover"
                    />
                  ) : (
                    <span className="flex aspect-square w-full items-center justify-center bg-canvas-100 text-[0.78rem] font-semibold text-ink-400">
                      Unavailable
                    </span>
                  )
                ) : (
                  // A 2x2 preview, not all N photos at full size — the point
                  // of an album card is to read as one post in the grid, the
                  // same way it reads as one notification to a parent.
                  <div className="grid aspect-square grid-cols-2 gap-0.5 bg-canvas-200">
                    {album.slice(0, 4).map((p, i) => (
                      <div key={p.id} className="relative overflow-hidden">
                        {p.url ? (
                          <img
                            src={p.url}
                            alt=""
                            loading="lazy"
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <span className="flex h-full w-full items-center justify-center bg-canvas-100 text-[0.7rem] font-semibold text-ink-400">
                            Unavailable
                          </span>
                        )}
                        {i === 3 && extra > 0 && (
                          <span className="absolute inset-0 flex items-center justify-center bg-ink-900/60 text-[1.05rem] font-extrabold text-white">
                            +{extra}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                <div className="flex items-start gap-2 p-3">
                  <div className="min-w-0 flex-1">
                    {/* The name is the whole reason this is one card instead
                        of several — it leads, same as a photo's caption does
                        for a single post. */}
                    {cover.album_name && (
                      <p className="truncate text-[0.9rem] font-extrabold text-grape-600">
                        {cover.album_name}
                      </p>
                    )}
                    <p
                      className="truncate text-[0.82rem] font-bold text-ink-800"
                      title={cover.children.join(', ')}
                    >
                      {/* A broadcast tags every active child, which reads as a
                          wall of names rather than useful information — the
                          count says what matters here. */}
                      {album.length > 1 && `${album.length} photos · `}
                      {cover.children.length > 6
                        ? `${cover.children.length} children · everyone`
                        : cover.children.join(', ') || 'Nobody tagged'}
                    </p>
                    <p className="truncate text-[0.76rem] font-medium text-ink-400">
                      {/* The day is on the card only when the grid spans days —
                          with a date filter on it is already at the top and
                          repeating it on every tile is noise. */}
                      {showingAll && `${cover.photo_date} · `}
                      by {cover.uploaded_by_name ?? 'a removed account'}
                    </p>
                    {cover.caption && (
                      <p className="truncate text-[0.76rem] font-medium text-ink-500">
                        {cover.caption}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    aria-label={
                      album.length === 1
                        ? 'Delete photo'
                        : `Delete all ${album.length} photos in this album`
                    }
                    onClick={async () => {
                      const ids = album.map((p) => p.id)
                      if (album.length === 1) {
                        if (await confirmDelete('this photo')) remove.mutate(ids[0])
                      } else if (
                        await confirmDelete(`these ${album.length} photos`)
                      ) {
                        removeAlbum.mutate(ids)
                      }
                    }}
                    className="flex size-8 shrink-0 items-center justify-center rounded-full text-ink-300 transition-colors hover:bg-berry-50 hover:text-berry-500"
                  >
                    <Trash2 className="size-4" strokeWidth={2.1} />
                  </button>
                </div>
              </Card>
            )
          })}
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
