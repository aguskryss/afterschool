import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Camera, X } from 'lucide-react'
import { api } from '@/lib/api'
import { Card, EmptyState, Skeleton } from '@/components/ui'

type Photo = {
  id: number
  photo_date: string
  caption: string | null
  url: string | null
  children: string[]
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  const today = new Date()
  const diff = Math.round(
    (new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime() -
      date.getTime()) /
      86_400_000,
  )
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * The family's own gallery.
 *
 * Every photo here is one their child appears in — the server never sends the
 * others. Grouped by day because that is how a parent looks for them: "what
 * happened Tuesday", not "photo 41".
 */
export function ParentPhotos() {
  const [open, setOpen] = useState<Photo | null>(null)

  const { data: photos, isPending } = useQuery({
    queryKey: ['parent', 'photos'],
    queryFn: () => api<Photo[]>('/api/parent/photos'),
  })

  const byDay = (photos ?? []).reduce<Record<string, Photo[]>>((acc, p) => {
    ;(acc[p.photo_date] ??= []).push(p)
    return acc
  }, {})
  const days = Object.keys(byDay).sort().reverse()

  return (
    <div className="mx-auto w-full max-w-2xl px-5 pt-5 pb-8">
      <h1 className="mb-4 text-[1.75rem] font-extrabold tracking-tight text-ink-900">
        Photos
      </h1>

      {isPending ? (
        <Skeleton className="h-48" />
      ) : days.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Camera className="size-7" strokeWidth={1.8} />}
            title="No photos yet"
            body="When counselors share photos of your child, they appear here."
          />
        </Card>
      ) : (
        days.map((day) => (
          <section key={day} className="mb-6">
            <h2 className="mb-2 text-[0.8rem] font-extrabold tracking-wide text-ink-400 uppercase">
              {dayLabel(day)}
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {byDay[day].map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => setOpen(p)}
                  className="overflow-hidden rounded-2xl bg-canvas-100 transition-transform active:scale-[0.98]"
                >
                  {p.url ? (
                    <img
                      src={p.url}
                      alt={p.caption ?? `Photo of ${p.children.join(', ')}`}
                      loading="lazy"
                      className="aspect-square w-full object-cover"
                    />
                  ) : (
                    <span className="flex aspect-square w-full items-center justify-center text-[0.78rem] font-semibold text-ink-400">
                      Unavailable
                    </span>
                  )}
                </button>
              ))}
            </div>
          </section>
        ))
      )}

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={open.caption ?? 'Photo'}
          onClick={() => setOpen(null)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/85 p-4"
        >
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(null)}
            className="absolute top-4 right-4 flex size-10 items-center justify-center rounded-full bg-white/15 text-white"
          >
            <X className="size-5" strokeWidth={2.4} />
          </button>
          <figure onClick={(e) => e.stopPropagation()} className="max-w-full">
            {open.url && (
              <img
                src={open.url}
                alt={open.caption ?? `Photo of ${open.children.join(', ')}`}
                className="max-h-[75vh] max-w-full rounded-2xl object-contain"
              />
            )}
            <figcaption className="mt-3 text-center text-[0.88rem] font-semibold text-white">
              {open.children.join(', ')}
              {open.caption && (
                <span className="block font-medium text-white/70">
                  {open.caption}
                </span>
              )}
            </figcaption>
          </figure>
        </div>
      )}
    </div>
  )
}
