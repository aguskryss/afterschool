import { useMemo, useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, Search } from 'lucide-react'
import { Card, EmptyState, Skeleton } from './ui'

export type Column<T> = {
  key: string
  header: string
  /** Cell contents. Defaults to the value at `key`. */
  render?: (row: T) => ReactNode
  /** Value used for sorting and searching. Defaults to the value at `key`. */
  value?: (row: T) => string | number
  align?: 'right'
  /** Hide below the lg breakpoint, for columns that don't fit a phone. */
  secondary?: boolean
}

/**
 * One table for every admin list.
 *
 * The old portal hand-rolled a `<table>` per section with no search, no sort
 * and no pagination, so finding one parent among hundreds meant Ctrl+F. Every
 * list now gets the same affordances for free, and the table scrolls inside
 * its own container so the page itself never scrolls sideways.
 */
export function DataTable<T extends { id: number | string }>({
  rows,
  columns,
  loading,
  searchPlaceholder = 'Search…',
  emptyTitle = 'Nothing here yet',
  emptyBody,
  emptyIcon,
  actions,
  onRowClick,
  pageSize = 25,
}: {
  rows: T[] | undefined
  columns: Column<T>[]
  loading?: boolean
  searchPlaceholder?: string
  emptyTitle?: string
  emptyBody?: string
  emptyIcon?: ReactNode
  actions?: ReactNode
  onRowClick?: (row: T) => void
  pageSize?: number
}) {
  const [query, setQuery] = useState('')
  const [sortKey, setSortKey] = useState<string | null>(null)
  const [asc, setAsc] = useState(true)
  const [page, setPage] = useState(0)

  const valueOf = (row: T, col: Column<T>): string | number =>
    col.value
      ? col.value(row)
      : ((row as Record<string, unknown>)[col.key] as string | number) ?? ''

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return rows ?? []
    return (rows ?? []).filter((row) =>
      columns.some((col) =>
        String(valueOf(row, col)).toLowerCase().includes(q),
      ),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, query, columns])

  const sorted = useMemo(() => {
    if (!sortKey) return filtered
    const col = columns.find((c) => c.key === sortKey)
    if (!col) return filtered
    return [...filtered].sort((a, b) => {
      const av = valueOf(a, col)
      const bv = valueOf(b, col)
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv))
      return asc ? cmp : -cmp
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortKey, asc, columns])

  const pages = Math.max(1, Math.ceil(sorted.length / pageSize))
  const current = Math.min(page, pages - 1)
  const visible = sorted.slice(current * pageSize, (current + 1) * pageSize)

  function toggleSort(key: string) {
    if (sortKey === key) setAsc((v) => !v)
    else {
      setSortKey(key)
      setAsc(true)
    }
    setPage(0)
  }

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 border-b border-canvas-200 p-3">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-ink-400"
            strokeWidth={2.2}
          />
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setPage(0)
            }}
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            className="h-10 w-full rounded-full border-2 border-canvas-200 bg-white pr-4 pl-10 text-[0.92rem] font-medium text-ink-900 outline-none transition placeholder:font-normal placeholder:text-ink-400 focus:border-sky-500"
          />
        </div>
        {actions}
      </div>

      {loading ? (
        <div className="flex flex-col gap-2 p-4">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : sorted.length === 0 ? (
        <EmptyState
          icon={emptyIcon}
          title={query ? 'No matches' : emptyTitle}
          body={
            query
              ? `Nothing matches “${query.trim()}”.`
              : emptyBody
          }
        />
      ) : (
        <>
          {/* Wide content scrolls inside its own container, never the page. */}
          <div className="overflow-x-auto">
            <table className="w-full min-w-max text-left text-[0.92rem]">
              <thead>
                <tr className="border-b border-canvas-200">
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      scope="col"
                      className={`px-4 py-2.5 font-extrabold text-ink-500 ${
                        col.align === 'right' ? 'text-right' : ''
                      } ${col.secondary ? 'hidden lg:table-cell' : ''}`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleSort(col.key)}
                        className="inline-flex items-center gap-1 hover:text-ink-800"
                      >
                        {col.header}
                        {sortKey === col.key &&
                          (asc ? (
                            <ArrowUp className="size-3.5" strokeWidth={2.6} />
                          ) : (
                            <ArrowDown className="size-3.5" strokeWidth={2.6} />
                          ))}
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-canvas-200">
                {visible.map((row) => (
                  <tr
                    key={row.id}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    className={
                      onRowClick ? 'cursor-pointer hover:bg-canvas-100' : ''
                    }
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={`px-4 py-3 font-medium text-ink-800 ${
                          col.align === 'right' ? 'text-right' : ''
                        } ${col.secondary ? 'hidden lg:table-cell' : ''}`}
                      >
                        {col.render
                          ? col.render(row)
                          : String(valueOf(row, col))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {pages > 1 && (
            <div className="flex items-center justify-between gap-3 border-t border-canvas-200 px-4 py-3 text-[0.85rem] font-semibold text-ink-500">
              <span>
                {current * pageSize + 1}–
                {Math.min((current + 1) * pageSize, sorted.length)} of{' '}
                {sorted.length}
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={current === 0}
                  onClick={() => setPage(current - 1)}
                  className="rounded-full px-3 py-1.5 font-bold transition-colors hover:bg-canvas-100 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={current >= pages - 1}
                  onClick={() => setPage(current + 1)}
                  className="rounded-full px-3 py-1.5 font-bold transition-colors hover:bg-canvas-100 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </Card>
  )
}
