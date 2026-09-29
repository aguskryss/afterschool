import { useRef, useState } from 'react'
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query'
import { Camera } from 'lucide-react'
import { api, ApiError } from '@/lib/api'
import { avatarPhoto } from '@/lib/image'
import { Avatar } from '@/components/ui'

/**
 * A child's large avatar that doubles as the way to set their profile photo.
 *
 * Shared by the admin's child profile and the parent's "My kids" cards: both
 * talk to the same server code (`/photo` under their own role's prefix), and a
 * second copy of the picker is exactly how one of them would end up accepting
 * a HEIC the other re-encodes.
 *
 * Tapping it opens the file picker straight away when there is no photo yet —
 * that is the only thing to do. With a photo, it offers change or remove.
 */
export function ChildPhoto({
  childId,
  name,
  photoUrl,
  endpoint,
  invalidate,
}: {
  childId: number
  name: string
  photoUrl: string | null | undefined
  /** '/api/admin/children' or '/api/parent/children'. */
  endpoint: string
  /** Queries that carry this child's photo_url and should refetch. */
  invalidate: QueryKey[]
}) {
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const url = `${endpoint}/${childId}/photo`

  const done = () => {
    setMenuOpen(false)
    setError(null)
    for (const key of invalidate) void qc.invalidateQueries({ queryKey: key })
  }
  const failed = (err: unknown) =>
    setError(
      err instanceof ApiError || err instanceof Error
        ? err.message
        : 'Could not update the photo.',
    )

  const upload = useMutation({
    mutationFn: async (file: File) => {
      const form = new FormData()
      form.append('file', await avatarPhoto(file))
      return api(url, { method: 'PUT', body: form })
    },
    onSuccess: done,
    onError: failed,
  })
  const remove = useMutation({
    mutationFn: () => api(url, { method: 'DELETE' }),
    onSuccess: done,
    onError: failed,
  })
  const busy = upload.isPending || remove.isPending

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        disabled={busy}
        aria-label={photoUrl ? `Change ${name}'s photo` : `Add a photo of ${name}`}
        aria-haspopup={photoUrl ? 'menu' : undefined}
        aria-expanded={photoUrl ? menuOpen : undefined}
        onClick={() => {
          setError(null)
          if (photoUrl) setMenuOpen((v) => !v)
          else input.current?.click()
        }}
        className={`relative block rounded-full ${busy ? 'opacity-60' : ''}`}
      >
        <Avatar name={name} id={childId} size="lg" photoUrl={photoUrl} />
        <span
          aria-hidden
          className="absolute -right-0.5 -bottom-0.5 inline-flex size-6 items-center justify-center rounded-full border-2 border-white bg-sky-500 text-white"
        >
          {busy ? (
            <span className="size-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
          ) : (
            <Camera className="size-3" strokeWidth={2.6} />
          )}
        </span>
      </button>

      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) upload.mutate(file)
        }}
      />

      {menuOpen && photoUrl && (
        <div
          role="menu"
          className="absolute top-full left-0 z-20 mt-2 flex w-40 flex-col overflow-hidden rounded-card bg-white py-1 shadow-soft"
        >
          <button
            type="button"
            role="menuitem"
            className="px-3.5 py-2 text-left text-[0.9rem] font-bold text-ink-700 hover:bg-canvas-100"
            onClick={() => {
              setMenuOpen(false)
              input.current?.click()
            }}
          >
            Change photo
          </button>
          <button
            type="button"
            role="menuitem"
            className="px-3.5 py-2 text-left text-[0.9rem] font-bold text-berry-600 hover:bg-berry-50"
            onClick={() => remove.mutate()}
          >
            Remove photo
          </button>
        </div>
      )}

      {error && (
        <p
          role="alert"
          className="absolute top-full left-0 z-20 mt-2 w-56 rounded-card bg-white p-2.5 text-[0.82rem] font-semibold text-berry-600 shadow-soft"
        >
          {error}
        </p>
      )}
    </div>
  )
}
